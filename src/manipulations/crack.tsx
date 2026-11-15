import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { numberField, randomOrNumberField } from "../core/fields";
import {
	defineManipulation,
	type EditorProps,
	type RenderContext,
} from "../core/manipulation";
import { cloneRaster, createRaster, samplerFor } from "../core/raster";
import {
	throughDisplacement,
	type Displacement,
	type Point,
} from "../core/remap";
import { randomSeed } from "../core/rng";
import { useRender } from "../core/useRender";
import { useAppElement } from "../store/appElement";
import { OutputStatus } from "../ui/OutputStatus";
import { breakInterface, imageGroup, paperPath } from "../ui/interfaceBreak";
import {
	imageToScreen,
	RasterView,
	type ImagePoint,
} from "../ui/RasterView";
import { shake } from "../ui/shake";

const paramsSchema = z.object({});

const pointSchema = z.object({ x: z.number(), y: z.number() });

/**
 * Cracks in the order they were opened, each in the image as it was after the
 * ones before it (where the user clicked). A crack runs along the line from
 * `a` (its thin end) to `b` (its wide end), and keeps going past them. `at` is
 * the click, which the crack follows when the Source changes. `id` seeds the
 * jagged edge.
 */
const stateSchema = z.object({
	cracks: z
		.array(
			z.object({
				id: z.number().int(),
				at: pointSchema,
				a: pointSchema,
				b: pointSchema,
				/** Gap width at `a` and at `b`, in px. */
				w0: z.number().min(0),
				w1: z.number().min(0),
				/** How far the edge zig-zags off the line, in px. */
				rough: z.number().min(0),
				/** Length of the long zig-zags along the line, in px. Missing: 5 × rough. */
				period: z.number().positive().optional(),
			}),
		)
		.default([]),
});

const toolsSchema = z.object({
	direction: randomOrNumberField({
		label: "Direction (°)",
		min: 0,
		max: 360,
		default: 90,
		random: true,
		hint: "From the thin end to the wide end. 90 = thin at the top",
	}),
	wide: numberField({ label: "Wide end (px)", min: 1, max: 100, default: 40 }),
	thin: numberField({ label: "Thin end (px)", min: 0, max: 100, default: 0 }),
	rough: numberField({
		label: "Roughness (px)",
		min: 0,
		max: 20,
		step: 0.5,
		default: 8,
		hint: "How far the edge zig-zags off the line",
	}),
	detail: numberField({
		label: "Detail",
		min: 0.5,
		max: 10,
		step: 0.5,
		default: 3,
		hint: "Zig-zags per 100px along the crack",
	}),
});

type Params = z.output<typeof paramsSchema>;
type State = z.output<typeof stateSchema>;
type Tools = z.output<typeof toolsSchema>;
type Crack = State["cracks"][number];

/** A hash of (seed, i) in [-1, 1]. */
function hash(seed: number, i: number): number {
	let h = Math.imul(seed ^ Math.imul(i, 0x9e3779b1), 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return ((h >>> 0) / 4294967296) * 2 - 1;
}

/** Piecewise-linear value noise: straight segments with sharp corners. */
function noise(seed: number, x: number): number {
	const i = Math.floor(x);
	const t = x - i;
	return hash(seed, i) * (1 - t) + hash(seed, i + 1) * t;
}

/**
 * A crack, ready to move points. In its frame, s runs along the line from the
 * thin end `a` and d across it. The + side (d > edge(s)) rotates by +β about
 * `a` and shifts by w0/2; the − side mirrors it. So each side moves rigidly,
 * and the gap is w0 at `a` and w1 at `b`, with both edges the same jagged line.
 */
interface CrackGeom {
	ax: number;
	ay: number;
	ux: number;
	uy: number;
	nx: number;
	ny: number;
	half0: number;
	cos: number;
	sin: number;
	/** Where the edge is across the line, at s. */
	edge(s: number): number;
}

function crackGeom(c: Crack): CrackGeom {
	const dx = c.b.x - c.a.x;
	const dy = c.b.y - c.a.y;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	const sin = Math.max(-1, Math.min(1, (c.w1 - c.w0) / (2 * len)));
	const amp = c.rough;
	// Long zig-zags with finer ones on top. The hash seeds come from the
	// crack's id, so remapping (which has no rng) sees the same edge as render.
	const period = c.period ?? Math.max(4, amp * 5);
	const seed2 = c.id ^ 0x5bd1e995;
	const edge =
		amp > 0
			? (s: number) =>
					amp *
					(0.75 * noise(c.id, s / period) +
						0.35 * noise(seed2, (s * 3.5) / period))
			: () => 0;
	return {
		ax: c.a.x,
		ay: c.a.y,
		ux,
		uy,
		nx: -uy,
		ny: ux,
		half0: c.w0 / 2,
		cos: Math.sqrt(1 - sin * sin),
		sin,
		edge,
	};
}

/**
 * Where an Output point (x, y) came from if it's on `side` (±1), and how much
 * it's on that side (0..1, anti-aliased across the edge).
 */
function preimage(
	g: CrackGeom,
	side: number,
	x: number,
	y: number,
): { x: number; y: number; cover: number; inside: number } {
	const rx = x - g.ax;
	const ry = y - g.ay;
	const s = rx * g.ux + ry * g.uy;
	const d = rx * g.nx + ry * g.ny - side * g.half0;
	// Undo the side's rotation by side·β.
	const s0 = s * g.cos + side * d * g.sin;
	const d0 = -side * s * g.sin + d * g.cos;
	const inside = side * (d0 - g.edge(s0));
	return {
		x: g.ax + s0 * g.ux + d0 * g.nx,
		y: g.ay + s0 * g.uy + d0 * g.ny,
		cover: Math.min(1, Math.max(0, inside + 0.5)),
		inside,
	};
}

function forward(g: CrackGeom, p: Point): Point {
	const rx = p.x - g.ax;
	const ry = p.y - g.ay;
	const s = rx * g.ux + ry * g.uy;
	const d = rx * g.nx + ry * g.ny;
	const side = d >= g.edge(s) ? 1 : -1;
	const s1 = s * g.cos - side * d * g.sin;
	const d1 = side * s * g.sin + d * g.cos + side * g.half0;
	return {
		x: g.ax + s1 * g.ux + d1 * g.nx,
		y: g.ay + s1 * g.uy + d1 * g.ny,
	};
}

function inverse(g: CrackGeom, p: Point): Point {
	const plus = preimage(g, 1, p.x, p.y);
	const minus = preimage(g, -1, p.x, p.y);
	// In the gap neither side claims it: take the nearer one.
	return plus.inside >= minus.inside ? plus : minus;
}

/** All the cracks in order, as one move of points. */
function displacement(state: State): Displacement {
	const geoms = state.cracks.map(crackGeom);
	return {
		forward: (p) => geoms.reduce((q, g) => forward(g, q), p),
		inverse: (p) => geoms.reduceRight((q, g) => inverse(g, q), p),
	};
}

/**
 * Open the cracks one after another, sampling the input once: each Output
 * pixel is traced back through every crack to the input. Near an edge a pixel
 * is partly on both sides, so it traces back both ways.
 */
async function render({ input, state, quality }: RenderContext<Params, State>) {
	if (state.cracks.length === 0) return { raster: cloneRaster(input) };
	const { width: W, height: H, data: src } = input;
	const geoms = state.cracks.map(crackGeom);
	const sample = samplerFor(quality);
	const out = createRaster(W, H);
	const o = out.data;
	const tmp = new Uint8ClampedArray(4);
	// Premultiplied sum of the samples a pixel traces back to.
	let r = 0;
	let gr = 0;
	let b = 0;
	let a = 0;

	const gather = (k: number, x: number, y: number, weight: number) => {
		if (k < 0) {
			tmp.fill(0);
			sample(src, W, H, x - 0.5, y - 0.5, tmp, 0);
			const al = tmp[3] * weight;
			r += tmp[0] * al;
			gr += tmp[1] * al;
			b += tmp[2] * al;
			a += al;
			return;
		}
		const g = geoms[k];
		for (const side of [1, -1]) {
			const pre = preimage(g, side, x, y);
			if (pre.cover > 0) gather(k - 1, pre.x, pre.y, weight * pre.cover);
		}
	};

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			r = gr = b = a = 0;
			gather(geoms.length - 1, x + 0.5, y + 0.5, 1);
			if (a <= 0) continue;
			const p = (y * W + x) * 4;
			o[p] = r / a;
			o[p + 1] = gr / a;
			o[p + 2] = b / a;
			o[p + 3] = Math.min(255, a);
		}
	}
	return { raster: out };
}

/** Where a line through `p` at `angle` enters and leaves the image, or null if it misses. */
function spanAcross(
	p: Point,
	angle: number,
	w: number,
	h: number,
): { a: Point; b: Point } | null {
	const u = [Math.cos(angle), Math.sin(angle)];
	const pos = [p.x, p.y];
	const size = [w, h];
	let t0 = -Infinity;
	let t1 = Infinity;
	for (let i = 0; i < 2; i++) {
		if (Math.abs(u[i]) < 1e-9) {
			if (pos[i] < 0 || pos[i] > size[i]) return null;
			continue;
		}
		const ta = -pos[i] / u[i];
		const tb = (size[i] - pos[i]) / u[i];
		t0 = Math.max(t0, Math.min(ta, tb));
		t1 = Math.min(t1, Math.max(ta, tb));
	}
	if (t1 - t0 < 1) return null;
	return {
		a: { x: p.x + t0 * u[0], y: p.y + t0 * u[1] },
		b: { x: p.x + t1 * u[0], y: p.y + t1 * u[1] },
	};
}

/**
 * The crack a click at `p` opens. `angle` (radians, thin end to wide end) is
 * the Tool setting's, or the random one drawn for the next click.
 */
function newCrack(
	p: Point,
	angle: number,
	tools: Tools,
	w: number,
	h: number,
): Crack | null {
	const span = spanAcross(p, angle, w, h);
	if (!span) return null;
	return {
		id: randomSeed(),
		at: { x: p.x, y: p.y },
		...span,
		w0: tools.thin,
		w1: tools.wide,
		rough: tools.rough,
		period: 100 / tools.detail,
	};
}

/**
 * The crack's gap in the Output, as a closed outline: its + edge, then its −
 * edge back, carried on past `a` and `b` along the line for s in [s0, s1]
 * (s measured from `a`). Past the thin end it narrows to a point; past the
 * wide end it keeps widening.
 */
function gapOutline(c: Crack, s0: number, s1: number): Point[] {
	const g = crackGeom(c);
	// The width there is 2·(half0 + s·sin): stop where it closes.
	if (g.sin > 0) s0 = Math.max(s0, -g.half0 / g.sin);
	else if (g.sin < 0) s1 = Math.min(s1, -g.half0 / g.sin);
	if (s1 <= s0) return [];
	const period = c.period ?? Math.max(4, c.rough * 5);
	// Fine enough for the finer zig-zags, but bounded for long spans.
	const step = Math.max(period / 8, (s1 - s0) / 3000);
	// Where the input's edge point at s goes on `side`, as in forward().
	const at = (s: number, side: number): Point => {
		const d = g.edge(s);
		const ss = s * g.cos - side * d * g.sin;
		const dd = side * s * g.sin + d * g.cos + side * g.half0;
		return { x: g.ax + ss * g.ux + dd * g.nx, y: g.ay + ss * g.uy + dd * g.ny };
	};
	const plus: Point[] = [];
	const minus: Point[] = [];
	for (let s = s0; ; s = Math.min(s1, s + step)) {
		plus.push(at(s, 1));
		minus.push(at(s, -1));
		if (s >= s1) break;
	}
	return [...plus, ...minus.reverse()];
}

/** How long a crack in the interface stays, in ms, plus per px of its wide end. */
const BREAK_HOLD_MS = 1500;
const BREAK_HOLD_PER_PX = 10;

/**
 * The crack carried on over the whole interface, as the same crack: the same
 * line and taper, white like the gap. Left out over the image, where the real
 * crack shows.
 */
function crackInterface(
	c: Crack,
	image: { width: number; height: number },
	toScreen: DOMMatrixReadOnly,
) {
	// How far along the line the window reaches, in image px.
	const toImage = toScreen.inverse();
	const ux = c.b.x - c.a.x;
	const uy = c.b.y - c.a.y;
	const len = Math.hypot(ux, uy) || 1;
	const along = [
		[0, 0],
		[window.innerWidth, 0],
		[0, window.innerHeight],
		[window.innerWidth, window.innerHeight],
	].map(([x, y]) => {
		const p = toImage.transformPoint(new DOMPoint(x, y));
		return ((p.x - c.a.x) * ux + (p.y - c.a.y) * uy) / len;
	});
	const pad = Math.max(c.w0, c.w1) + c.rough;
	const outline = gapOutline(
		c,
		Math.min(...along) - pad,
		Math.max(...along) + pad,
	);
	if (outline.length === 0) return;
	breakInterface({
		holdMs: BREAK_HOLD_MS + c.w1 * BREAK_HOLD_PER_PX,
		draw: (container) =>
			imageGroup(container, toScreen, {
				x: 0,
				y: 0,
				width: image.width,
				height: image.height,
			}).append(
				paperPath(`M${outline.map((p) => `${p.x} ${p.y}`).join("L")}Z`),
			),
	});
}

/** When, into the shake, the crack opens. */
const BURST_AT_MS = 60;
/** Wide-end width (px) up to which the shake stays at its minimum. */
const SHAKE_BASE_WIDTH = 40;
/** How much harder a crack shakes than a single shot. */
const SHAKE_STRENGTH = 8;

/** A random direction for the next crack (editor only, never in render). */
const rollAngle = () => Math.random() * 2 * Math.PI;

/** Where a crack would run: its axis, from the thin end to the wide end. */
function Axis({ crack }: { crack: Crack }) {
	const { a, b } = crack;
	return (
		<line
			x1={a.x}
			y1={a.y}
			x2={b.x}
			y2={b.y}
			stroke="#e5484d"
			strokeWidth={1}
			strokeDasharray="4 3"
			vectorEffect="non-scaling-stroke"
			pointerEvents="none"
		/>
	);
}

function CrackEditor({
	input,
	params,
	state,
	setState,
	tools,
	seed,
	assets,
}: EditorProps<Params, State, Tools>) {
	const result = useRender(render, input, params, state, seed, assets);
	const [hover, setHover] = useState<ImagePoint | null>(null);
	// Drawn ahead, so the preview shows the crack the next click opens. Only
	// the crack's ends go into State, so Recipes still reproduce.
	const [randomAngle, setRandomAngle] = useState(rollAngle);
	const angle = tools.direction.random
		? randomAngle
		: (tools.direction.value * Math.PI) / 180;
	const preview =
		hover && newCrack(hover, angle, tools, input.width, input.height);

	// A click shakes at once; BURST_AT_MS later (or once its render lands, if
	// later still) the crack opens in the image and across the interface
	// together. Until then the preview holds the image from before the click.
	const [held, setHeld] = useState<ImageData | null>(null);
	const bursts = useRef<
		{ crack: Crack; toScreen: DOMMatrixReadOnly; at: number }[]
	>([]);
	const burstTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => clearTimeout(burstTimer.current), []);
	useEffect(() => {
		if (bursts.current.length === 0 || !result.output) return;
		// This output is the latest State's, so it has every clicked crack
		// that's still there.
		const opened = new Set(state.cracks.map((c) => c.id));
		const at = Math.max(...bursts.current.map((b) => b.at));
		clearTimeout(burstTimer.current);
		burstTimer.current = window.setTimeout(
			() => {
				for (const { crack, toScreen } of bursts.current) {
					// Gone already (e.g. undone): it never opened.
					if (opened.has(crack.id)) crackInterface(crack, input, toScreen);
				}
				bursts.current = [];
				setHeld(null);
			},
			Math.max(0, at - performance.now()),
		);
	}, [result.output]);

	return (
		<>
			<RasterView
				// Output is the same size as input, so image coords map 1:1.
				image={held ?? result.output?.raster ?? input}
				cursor="crosshair"
				onPointerMove={setHover}
				onPointerLeave={() => setHover(null)}
				onPointerDown={(p, e) => {
					const crack = newCrack(p, angle, tools, input.width, input.height);
					if (!crack) return;
					// A newer render is coming: don't open anything before it lands.
					clearTimeout(burstTimer.current);
					setHeld((h) => h ?? result.output?.raster ?? input);
					setState((s) => ({ ...s, cracks: [...s.cracks, crack] }));
					bursts.current.push({
						crack,
						toScreen: imageToScreen(e.currentTarget),
						at: performance.now() + BURST_AT_MS,
					});
					// The sides are about to burst apart: shake across the crack,
					// harder for wider ones.
					shake(
						useAppElement.getState().appElement,
						Math.max(1, crack.w1 / SHAKE_BASE_WIDTH) * SHAKE_STRENGTH,
						-Math.sin(angle),
						Math.cos(angle),
					);
					setRandomAngle(rollAngle());
				}}
				overlay={preview && <Axis crack={preview} />}
			/>
			<OutputStatus result={result} />
		</>
	);
}

export const crack = defineManipulation({
	id: "crack",
	version: 1,
	label: "Crack",
	paramsSchema,
	stateSchema,
	toolsSchema,
	render,
	// A crack follows the letter under its click, keeping its shape. Each crack
	// lives in the image after the ones before it, so the move is carried
	// through those first.
	remapState: (state, remap) => {
		let r = remap;
		const cracks = state.cracks.map((c) => {
			const to = r.point(c.at);
			const k = r.scale;
			const move = (p: Point) => ({
				x: to.x + (p.x - c.at.x) * k,
				y: to.y + (p.y - c.at.y) * k,
			});
			const moved = {
				...c,
				at: to,
				a: move(c.a),
				b: move(c.b),
				w0: c.w0 * k,
				w1: c.w1 * k,
				rough: c.rough * k,
				period: c.period && c.period * k,
			};
			r = throughDisplacement(
				r,
				displacement({ cracks: [c] }),
				displacement({ cracks: [moved] }),
			);
			return moved;
		});
		return { ...state, cracks };
	},
	displacement,
	Component: CrackEditor,
});
