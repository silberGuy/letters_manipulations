import { useEffect, useMemo, useState, type PointerEvent } from "react";
import { z } from "zod";
import { numberField } from "../core/fields";
import {
	defineManipulation,
	type EditorProps,
	type RenderContext,
} from "../core/manipulation";
import { createRaster, sampleBilinear } from "../core/raster";
import { remapItems } from "../core/remap";
import { useRender } from "../core/useRender";
import { OutputStatus } from "../ui/OutputStatus";
import { RasterView, type ImagePoint } from "../ui/RasterView";

const paramsSchema = z.object({
	cellSize: numberField({
		label: "Cell size (px)",
		min: 8,
		max: 200,
		default: 60,
	}),
});

/**
 * Moved Grid Points. Each stores where its node rests (input pixels) and how
 * far it was dragged. Render snaps the rest position to the nearest node of
 * the current grid, so moves survive text and cell-size changes.
 */
const stateSchema = z.object({
	moves: z
		.array(
			z.object({
				x: z.number(),
				y: z.number(),
				dx: z.number(),
				dy: z.number(),
			}),
		)
		.default([]),
});

const toolsSchema = z.object({});

type Params = z.output<typeof paramsSchema>;
type State = z.output<typeof stateSchema>;
type Tools = z.output<typeof toolsSchema>;
type Move = State["moves"][number];

// ---------------------------------------------------------------------------
// Grid geometry

interface Grid {
	cols: number;
	rows: number;
	/** Cell width and height in input pixels; the grid spans the input exactly. */
	cw: number;
	ch: number;
}

function gridOf(w: number, h: number, cellSize: number): Grid {
	const cols = Math.max(1, Math.round(w / cellSize));
	const rows = Math.max(1, Math.round(h / cellSize));
	return { cols, rows, cw: w / cols, ch: h / rows };
}

const nodeIndex = (g: Grid, i: number, j: number) => j * (g.cols + 1) + i;

function nodeOf(g: Grid, p: { x: number; y: number }): [number, number] {
	const i = Math.min(g.cols, Math.max(0, Math.round(p.x / g.cw)));
	const j = Math.min(g.rows, Math.max(0, Math.round(p.y / g.ch)));
	return [i, j];
}

/** Node offsets from the moves; later moves on the same node win. */
function offsetsOf(
	g: Grid,
	moves: readonly Move[],
): Map<number, { dx: number; dy: number }> {
	const out = new Map<number, { dx: number; dy: number }>();
	for (const m of moves) {
		const [i, j] = nodeOf(g, m);
		out.set(nodeIndex(g, i, j), { dx: m.dx, dy: m.dy });
	}
	return out;
}

/** Displaced node positions in input pixels, as flat x/y arrays. */
function positionsOf(g: Grid, moves: readonly Move[]) {
	const n = (g.cols + 1) * (g.rows + 1);
	const xs = new Float64Array(n);
	const ys = new Float64Array(n);
	const offsets = offsetsOf(g, moves);
	for (let j = 0; j <= g.rows; j++) {
		for (let i = 0; i <= g.cols; i++) {
			const k = nodeIndex(g, i, j);
			const o = offsets.get(k);
			xs[k] = i * g.cw + (o?.dx ?? 0);
			ys[k] = j * g.ch + (o?.dy ?? 0);
		}
	}
	return { xs, ys };
}

/** Where the Output's (0,0) sits in input pixels: it grows to fit moved points. */
function originOf(w: number, h: number, xs: Float64Array, ys: Float64Array) {
	let minX = 0,
		minY = 0,
		maxX = w,
		maxY = h;
	for (let k = 0; k < xs.length; k++) {
		minX = Math.min(minX, xs[k]);
		maxX = Math.max(maxX, xs[k]);
		minY = Math.min(minY, ys[k]);
		maxY = Math.max(maxY, ys[k]);
	}
	const x = Math.floor(minX);
	const y = Math.floor(minY);
	return { x, y, width: Math.ceil(maxX) - x, height: Math.ceil(maxY) - y };
}

// ---------------------------------------------------------------------------
// Render

/**
 * Inverse bilinear: find (u, v) in [0,1]² with
 * p = a + (b-a)u + (d-a)v + (a-b+c-d)uv, for quad a b c d (clockwise from top-left).
 */
function invBilinear(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
	dx: number,
	dy: number,
	out: [number, number],
): boolean {
	const ex = bx - ax,
		ey = by - ay;
	const fx = dx - ax,
		fy = dy - ay;
	const gx = ax - bx + cx - dx,
		gy = ay - by + cy - dy;
	const hx = px - ax,
		hy = py - ay;
	const k2 = gx * fy - gy * fx;
	const k1 = ex * fy - ey * fx + hx * gy - hy * gx;
	const k0 = hx * ey - hy * ex;
	const EPS = 1e-4;

	const tryV = (v: number): boolean => {
		if (!(v >= -EPS && v <= 1 + EPS)) return false;
		const denX = ex + gx * v;
		const denY = ey + gy * v;
		let u: number;
		if (Math.abs(denX) >= Math.abs(denY)) {
			if (Math.abs(denX) < 1e-12) return false;
			u = (hx - fx * v) / denX;
		} else {
			u = (hy - fy * v) / denY;
		}
		if (!(u >= -EPS && u <= 1 + EPS)) return false;
		out[0] = Math.min(1, Math.max(0, u));
		out[1] = Math.min(1, Math.max(0, v));
		return true;
	};

	if (Math.abs(k2) <= 1e-9 * (Math.abs(k1) + 1e-9)) {
		if (Math.abs(k1) < 1e-12) return false;
		return tryV(-k0 / k1);
	}
	const disc = k1 * k1 - 4 * k0 * k2;
	if (disc < 0) return false;
	const s = Math.sqrt(disc);
	return tryV((-k1 - s) / (2 * k2)) || tryV((-k1 + s) / (2 * k2));
}

/**
 * Warp the input through the grid: each cell is mapped bilinearly onto the
 * quad of its four (possibly moved) corners. Where quads fold over each
 * other, the cell earlier in reading order wins.
 */
async function render({ input, params, state }: RenderContext<Params, State>) {
	const { width: w, height: h, data: src } = input;
	const g = gridOf(w, h, params.cellSize);
	const { xs, ys } = positionsOf(g, state.moves);
	const o = originOf(w, h, xs, ys);
	const out = createRaster(o.width, o.height);
	const W = out.width,
		H = out.height;
	const dst = out.data;
	const written = new Uint8Array(W * H);
	const uv: [number, number] = [0, 0];

	for (let j = 0; j < g.rows; j++) {
		for (let i = 0; i < g.cols; i++) {
			const a = nodeIndex(g, i, j),
				b = nodeIndex(g, i + 1, j);
			const c = nodeIndex(g, i + 1, j + 1),
				d = nodeIndex(g, i, j + 1);
			const qx0 = Math.min(xs[a], xs[b], xs[c], xs[d]) - o.x;
			const qx1 = Math.max(xs[a], xs[b], xs[c], xs[d]) - o.x;
			const qy0 = Math.min(ys[a], ys[b], ys[c], ys[d]) - o.y;
			const qy1 = Math.max(ys[a], ys[b], ys[c], ys[d]) - o.y;
			const x0 = Math.max(0, Math.floor(qx0)),
				x1 = Math.min(W - 1, Math.ceil(qx1));
			const y0 = Math.max(0, Math.floor(qy0)),
				y1 = Math.min(H - 1, Math.ceil(qy1));

			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const p = y * W + x;
					if (written[p]) continue;
					const ok = invBilinear(
						x + 0.5 + o.x,
						y + 0.5 + o.y,
						xs[a],
						ys[a],
						xs[b],
						ys[b],
						xs[c],
						ys[c],
						xs[d],
						ys[d],
						uv,
					);
					if (!ok) continue;
					written[p] = 1;
					sampleBilinear(
						src,
						w,
						h,
						(i + uv[0]) * g.cw - 0.5,
						(j + uv[1]) * g.ch - 0.5,
						dst,
						p * 4,
					);
				}
			}
		}
	}
	return { raster: out };
}

// The Output origin of each rendered raster, so the editor maps pointer and
// overlay coordinates for the image actually on screen (it may lag the state).
const renderedOrigin = new WeakMap<ImageData, { x: number; y: number }>();
async function renderForEditor(ctx: RenderContext<Params, State>) {
	const output = await render(ctx);
	const { xs, ys } = positionsOf(
		gridOf(ctx.input.width, ctx.input.height, ctx.params.cellSize),
		ctx.state.moves,
	);
	renderedOrigin.set(
		output.raster,
		originOf(ctx.input.width, ctx.input.height, xs, ys),
	);
	return output;
}

// ---------------------------------------------------------------------------
// Editor

/** Handle radius on screen, in CSS px. */
const HANDLE_PX = 4;
const HIT_PX = 9;

type Drag =
	| { kind: "move"; start: ImagePoint; delta: ImagePoint }
	| { kind: "box"; start: ImagePoint; end: ImagePoint; additive: boolean };

/** Set node offsets for the given nodes (by index), dropping zero ones. */
function withOffsets(
	state: State,
	g: Grid,
	nodes: Map<number, { dx: number; dy: number }>,
): State {
	const kept = state.moves.filter((m) => {
		const [i, j] = nodeOf(g, m);
		return !nodes.has(nodeIndex(g, i, j));
	});
	const added: Move[] = [];
	for (const [k, { dx, dy }] of nodes) {
		if (Math.hypot(dx, dy) < 1e-3) continue;
		const i = k % (g.cols + 1),
			j = Math.floor(k / (g.cols + 1));
		added.push({ x: i * g.cw, y: j * g.ch, dx, dy });
	}
	return { ...state, moves: [...kept, ...added] };
}

/** The selected nodes moved by delta on top of their current offsets. */
function shifted(
	state: State,
	g: Grid,
	selection: Set<number>,
	delta: ImagePoint,
): State {
	const offsets = offsetsOf(g, state.moves);
	const nodes = new Map<number, { dx: number; dy: number }>();
	for (const k of selection) {
		const o = offsets.get(k) ?? { dx: 0, dy: 0 };
		nodes.set(k, { dx: o.dx + delta.x, dy: o.dy + delta.y });
	}
	return withOffsets(state, g, nodes);
}

function GridWarpEditor({
	input,
	params,
	state,
	setState,
	seed,
	assets,
}: EditorProps<Params, State, Tools>) {
	const g = useMemo(
		() => gridOf(input.width, input.height, params.cellSize),
		[input.width, input.height, params.cellSize],
	);
	const nodeCount = (g.cols + 1) * (g.rows + 1);
	const [selection, setSelection] = useState<Set<number>>(() => new Set());
	const [drag, setDrag] = useState<Drag | null>(null);
	const [hoverNode, setHoverNode] = useState<number | null>(null);
	/** Screen px per image px, read from the overlay. */
	const [zoom, setZoom] = useState(1);

	// Selection indexes the current grid; a new grid starts unselected.
	useEffect(() => setSelection(new Set()), [g.cols, g.rows]);

	const shownState = useMemo(
		() =>
			drag?.kind === "move" ? shifted(state, g, selection, drag.delta) : state,
		[state, g, selection, drag],
	);
	const result = useRender(
		renderForEditor,
		input,
		params,
		shownState,
		seed,
		assets,
	);
	const image = result.output?.raster ?? input;
	const origin = renderedOrigin.get(image) ?? { x: 0, y: 0 };
	const { xs, ys } = useMemo(
		() => positionsOf(g, shownState.moves),
		[g, shownState],
	);

	const toInput = (p: ImagePoint): ImagePoint => ({
		x: p.x + origin.x,
		y: p.y + origin.y,
	});
	const readZoom = (e: PointerEvent<SVGSVGElement>) => {
		const z = e.currentTarget.getScreenCTM()?.a;
		if (z && Math.abs(z - zoom) > 1e-6) setZoom(z);
		return z || zoom;
	};

	const nodeAt = (q: ImagePoint, z: number): number | null => {
		const r = HIT_PX / z;
		let best: number | null = null;
		let bestD = r;
		for (let k = 0; k < nodeCount; k++) {
			const d = Math.hypot(xs[k] - q.x, ys[k] - q.y);
			if (d <= bestD) {
				bestD = d;
				best = k;
			}
		}
		return best;
	};

	const onDown = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		const z = readZoom(e);
		const q = toInput(p);
		const hit = nodeAt(q, z);
		if (hit !== null) {
			if (!selection.has(hit))
				setSelection(
					e.shiftKey ? new Set([...selection, hit]) : new Set([hit]),
				);
			setDrag({ kind: "move", start: q, delta: { x: 0, y: 0 } });
		} else {
			setDrag({ kind: "box", start: q, end: q, additive: e.shiftKey });
		}
	};

	const onMove = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		const z = readZoom(e);
		const q = toInput(p);
		if (!drag) {
			setHoverNode(nodeAt(q, z));
			return;
		}
		if (drag.kind === "move")
			setDrag({
				...drag,
				delta: { x: q.x - drag.start.x, y: q.y - drag.start.y },
			});
		else setDrag({ ...drag, end: q });
	};

	const onUp = () => {
		if (!drag) return;
		if (drag.kind === "move") {
			const { delta } = drag;
			if (delta.x !== 0 || delta.y !== 0)
				setState((s) => shifted(s, g, selection, delta));
		} else {
			const x0 = Math.min(drag.start.x, drag.end.x),
				x1 = Math.max(drag.start.x, drag.end.x);
			const y0 = Math.min(drag.start.y, drag.end.y),
				y1 = Math.max(drag.start.y, drag.end.y);
			const next = new Set(drag.additive ? selection : []);
			for (let k = 0; k < nodeCount; k++) {
				if (xs[k] >= x0 && xs[k] <= x1 && ys[k] >= y0 && ys[k] <= y1)
					next.add(k);
			}
			setSelection(next);
		}
		setDrag(null);
	};

	// Escape deselects; Delete / Backspace puts the selected points back.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			if (
				t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable)
			)
				return;
			if (e.key === "Escape") setSelection(new Set());
			else if (
				(e.key === "Delete" || e.key === "Backspace") &&
				selection.size > 0
			) {
				e.preventDefault();
				setState((s) =>
					withOffsets(
						s,
						g,
						new Map([...selection].map((k) => [k, { dx: 0, dy: 0 }])),
					),
				);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selection, g, setState]);

	const lines: string[] = [];
	for (let j = 0; j <= g.rows; j++) {
		const pts: string[] = [];
		for (let i = 0; i <= g.cols; i++)
			pts.push(`${xs[nodeIndex(g, i, j)]},${ys[nodeIndex(g, i, j)]}`);
		lines.push(pts.join(" "));
	}
	for (let i = 0; i <= g.cols; i++) {
		const pts: string[] = [];
		for (let j = 0; j <= g.rows; j++)
			pts.push(`${xs[nodeIndex(g, i, j)]},${ys[nodeIndex(g, i, j)]}`);
		lines.push(pts.join(" "));
	}

	const handles = [];
	const r = HANDLE_PX / zoom;
	for (let k = 0; k < nodeCount; k++) {
		const selected = selection.has(k);
		const size = selected || k === hoverNode ? r * 1.4 : r;
		handles.push(
			<rect
				key={k}
				className={selected ? "grid-point selected" : "grid-point"}
				x={xs[k] - size}
				y={ys[k] - size}
				width={size * 2}
				height={size * 2}
				vectorEffect="non-scaling-stroke"
			/>,
		);
	}

	const box =
		drag?.kind === "box" ? (
			<rect
				x={Math.min(drag.start.x, drag.end.x)}
				y={Math.min(drag.start.y, drag.end.y)}
				width={Math.abs(drag.end.x - drag.start.x)}
				height={Math.abs(drag.end.y - drag.start.y)}
				className="grid-select-box"
				vectorEffect="non-scaling-stroke"
			/>
		) : null;

	return (
		<>
			<RasterView
				image={image}
				cursor={
					drag?.kind === "move"
						? "grabbing"
						: hoverNode !== null
							? "grab"
							: "crosshair"
				}
				onPointerDown={onDown}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onPointerLeave={() => setHoverNode(null)}
				overlay={
					// Overlay is drawn in input pixels; the Output may have grown up/left.
					<g
						transform={`translate(${-origin.x} ${-origin.y})`}
						pointerEvents="none"
					>
						{lines.map((pts, n) => (
							<polyline
								key={n}
								points={pts}
								className="grid-line"
								vectorEffect="non-scaling-stroke"
							/>
						))}
						{handles}
						{box}
					</g>
				}
			/>
			<OutputStatus result={result} />
		</>
	);
}

export const gridWarp = defineManipulation({
	id: "grid-warp",
	version: 1,
	label: "Grid Warp",
	paramsSchema,
	stateSchema,
	toolsSchema,
	render,
	// A moved point goes with the letter under it, its offset scaled with the text.
	remapState: (state, remap) => ({
		...state,
		moves: remapItems(state.moves, remap, {
			samples: (m) => [m],
			dropAbove: 0.5,
			move: (m, [{ to }]) => ({
				x: to.x,
				y: to.y,
				dx: m.dx * remap.scale,
				dy: m.dy * remap.scale,
			}),
		}),
	}),
	Component: GridWarpEditor,
});
