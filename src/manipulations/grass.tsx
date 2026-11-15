import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { z } from "zod";
import { numberField } from "../core/fields";
import {
	defineManipulation,
	type EditorProps,
	type RenderContext,
} from "../core/manipulation";
import { context2d, inkColor, rasterToCanvas, rgbToHex } from "../core/raster";
import { remapItems, type Remap } from "../core/remap";
import { createRng, randomSeed, type Rng } from "../core/rng";
import { useRender } from "../core/useRender";
import {
	vectorize,
	vectorizeOptionsSchema,
	type VectorizeOptions,
} from "../vectorize/vectorize";
import { OutputStatus } from "../ui/OutputStatus";
import {
	imageToScreen,
	isOnCanvas,
	RasterView,
	type ImagePoint,
} from "../ui/RasterView";
import {
	cropPixels,
	snapshotInterface,
	type InterfaceSnapshot,
} from "../ui/snapshot";
import {
	interfaceInk,
	snapshotBox,
	snapshotBreak,
	toSnapshot,
	type SnapshotBreak,
} from "../ui/snapshotBreak";
import { ScreenOverlay } from "../ui/ScreenOverlay";

/** Cap on blades per press, so a very long press stays renderable. */
const MAX_BLADES_PER_PRESS = 1000;
/** A pixel is ink from 50% alpha. */
const INK_ALPHA = 128;
/** Half-side (px) of the window the outward normal is estimated over. */
const NORMAL_WINDOW = 3;
/** Points sampled along each blade's center curve. */
const BLADE_SAMPLES = 16;
/**
 * During a drag, a new press starts once the pointer is this share of the
 * brush radius away from the current one.
 */
const TRAIL_SPACING = 0.5;
const TRACE_SMOOTHNESS = 1;
const TRACE_TOLERANCE = 0.2;

const paramsSchema = z.object({
	minLength: numberField({
		label: "Min length (px)",
		min: 1,
		max: 200,
		step: 0.5,
		default: 8,
	}),
	maxLength: numberField({
		label: "Max length (px)",
		min: 1,
		max: 300,
		step: 0.5,
		default: 20,
	}),
	baseWidth: numberField({
		label: "Base width (px)",
		min: 0.5,
		max: 20,
		step: 0.5,
		default: 2.5,
	}),
	maxTilt: numberField({
		label: "Max tilt (°)",
		min: 0,
		max: 90,
		default: 20,
	}),
	maxCurvature: numberField({
		label: "Max curvature",
		min: 0,
		max: 1,
		step: 0.05,
		default: 0.3,
		hint: "How far a blade's middle bends sideways, as a share of its length",
	}),
	threshold: vectorizeOptionsSchema.shape.threshold,
	speckle: vectorizeOptionsSchema.shape.speckle,
});

/**
 * How the grass grows from a press. Set as Tool settings and copied into each
 * press when it's made, so presses made with different settings keep them.
 */
const growthSchema = z.object({
	radius: numberField({
		label: "Brush radius (px)",
		min: 1,
		max: 200,
		default: 30,
	}),
	rate: numberField({
		label: "Growth rate",
		min: 0.05,
		max: 5,
		step: 0.05,
		default: 0.5,
		hint: "Blades per px of edge per second",
	}),
	growTime: numberField({
		label: "Grow time (s)",
		min: 0,
		max: 5,
		step: 0.05,
		default: 0.4,
	}),
});

/**
 * Presses in input pixels. `duration` is how long, in seconds, the pointer
 * stayed at that press. `id` picks the press's random stream, so removing one
 * press doesn't change the others.
 */
const stateSchema = z.object({
	presses: z
		.array(
			growthSchema.extend({
				id: z.number().int(),
				x: z.number(),
				y: z.number(),
				duration: z.number().nonnegative(),
			}),
		)
		.default([]),
});

const toolsSchema = growthSchema;

type Params = z.output<typeof paramsSchema>;
type State = z.output<typeof stateSchema>;
type Tools = z.output<typeof toolsSchema>;
type Press = State["presses"][number];
type Vec = [number, number];

// ---------------------------------------------------------------------------
// Blades

function alphaAt(input: ImageData, x: number, y: number): number {
	if (x < 0 || y < 0 || x >= input.width || y >= input.height) return 0;
	return input.data[(y * input.width + x) * 4 + 3];
}

/** Ink pixels within the brush that touch paper (4-neighbours), in scan order. */
function edgePixels(input: ImageData, press: Press): Vec[] {
	const out: Vec[] = [];
	const r = press.radius;
	const x0 = Math.max(0, Math.floor(press.x - r));
	const x1 = Math.min(input.width - 1, Math.ceil(press.x + r));
	const y0 = Math.max(0, Math.floor(press.y - r));
	const y1 = Math.min(input.height - 1, Math.ceil(press.y + r));
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			if (Math.hypot(x + 0.5 - press.x, y + 0.5 - press.y) > r) continue;
			if (alphaAt(input, x, y) < INK_ALPHA) continue;
			if (
				alphaAt(input, x + 1, y) < INK_ALPHA ||
				alphaAt(input, x - 1, y) < INK_ALPHA ||
				alphaAt(input, x, y + 1) < INK_ALPHA ||
				alphaAt(input, x, y - 1) < INK_ALPHA
			)
				out.push([x, y]);
		}
	}
	return out;
}

/**
 * Unit normal pointing from the ink into the paper at pixel (x, y): minus the
 * coverage gradient, smoothed over a small window. Null where it's undefined.
 */
function outwardNormal(input: ImageData, x: number, y: number): Vec | null {
	let gx = 0;
	let gy = 0;
	const R = NORMAL_WINDOW;
	for (let dy = -R; dy <= R; dy++) {
		for (let dx = -R; dx <= R; dx++) {
			if (dx === 0 && dy === 0) continue;
			const w = Math.exp(-(dx * dx + dy * dy) / (R * R)) / (dx * dx + dy * dy);
			const a = alphaAt(input, x + dx, y + dy);
			gx += a * dx * w;
			gy += a * dy * w;
		}
	}
	const len = Math.hypot(gx, gy);
	return len > 1e-6 ? [-gx / len, -gy / len] : null;
}

/** A blade's outline: a tapered quadratic curve from inside the ink out to a sharp tip. */
function bladeOutline(
	edge: Vec,
	normal: Vec,
	length: number,
	tilt: number,
	curvature: number,
	baseWidth: number,
): Vec[] {
	const [nx, ny] = normal;
	const cos = Math.cos(tilt);
	const sin = Math.sin(tilt);
	const dx = nx * cos - ny * sin;
	const dy = nx * sin + ny * cos;
	// Start inside the ink so the base merges into the letter with no seam.
	const S: Vec = [edge[0] - nx * baseWidth, edge[1] - ny * baseWidth];
	const T: Vec = [edge[0] + dx * length, edge[1] + dy * length];
	const cx = T[0] - S[0];
	const cy = T[1] - S[1];
	const chord = Math.hypot(cx, cy) || 1;
	const C: Vec = [
		(S[0] + T[0]) / 2 - (cy / chord) * curvature * chord,
		(S[1] + T[1]) / 2 + (cx / chord) * curvature * chord,
	];

	const left: Vec[] = [];
	const right: Vec[] = [];
	for (let i = 0; i < BLADE_SAMPLES; i++) {
		const s = i / BLADE_SAMPLES;
		const u = 1 - s;
		const px = u * u * S[0] + 2 * u * s * C[0] + s * s * T[0];
		const py = u * u * S[1] + 2 * u * s * C[1] + s * s * T[1];
		let tx = 2 * u * (C[0] - S[0]) + 2 * s * (T[0] - C[0]);
		let ty = 2 * u * (C[1] - S[1]) + 2 * s * (T[1] - C[1]);
		const tl = Math.hypot(tx, ty) || 1;
		tx /= tl;
		ty /= tl;
		const hw = (baseWidth / 2) * u;
		left.push([px - ty * hw, py + tx * hw]);
		right.push([px + ty * hw, py - tx * hw]);
	}
	return [...left, T, ...right.reverse()];
}

/**
 * One press's blades. Blades appear at a constant rate along the edges in the
 * brush (Poisson in time), each growing to full length over `growTime`. The
 * edge list depends only on the press, so a longer press only adds blades.
 */
function pressBlades(
	input: ImageData,
	press: Press,
	params: Params,
	rng: Rng,
): Vec[][] {
	const edges = edgePixels(input, press);
	const rate = press.rate * edges.length;
	const out: Vec[][] = [];
	if (!(rate > 0) || !(press.duration > 0)) return out;

	const maxTilt = (params.maxTilt * Math.PI) / 180;
	let t = 0;
	for (let n = 0; n < MAX_BLADES_PER_PRESS; n++) {
		// Draw every value up front, so later blades never depend on how earlier ones are used.
		t += -Math.log(1 - rng.next()) / rate;
		const pick = rng.next();
		const jx = rng.next();
		const jy = rng.next();
		const lengthDraw = rng.next();
		const tiltDraw = rng.next();
		const curveDraw = rng.next();
		if (t > press.duration) break;

		const [x, y] = edges[Math.floor(pick * edges.length)];
		const normal = outwardNormal(input, x, y);
		if (!normal) continue;
		const age = press.growTime > 0 ? Math.min(1, (press.duration - t) / press.growTime) : 1;
		const eased = 1 - (1 - age) * (1 - age);
		const length =
			(params.minLength + lengthDraw * (params.maxLength - params.minLength)) * eased;
		if (length <= 0) continue;
		out.push(
			bladeOutline(
				[x + jx, y + jy],
				normal,
				length,
				(tiltDraw * 2 - 1) * maxTilt,
				(curveDraw * 2 - 1) * params.maxCurvature,
				params.baseWidth,
			),
		);
	}
	return out;
}

function allBlades(input: ImageData, params: Params, state: State, rng: Rng): Vec[][] {
	return state.presses.flatMap((press) =>
		pressBlades(input, press, params, rng.fork(`press-${press.id}`)),
	);
}

// ---------------------------------------------------------------------------
// Output

/**
 * Pure memo of the trace of an input: the same input and options always give
 * the same SVG, so caching doesn't affect determinism.
 */
const traceCache = new WeakMap<ImageData, Map<string, Promise<string>>>();

function traceInk(input: ImageData, options: VectorizeOptions): Promise<string> {
	let byOptions = traceCache.get(input);
	if (!byOptions) traceCache.set(input, (byOptions = new Map()));
	const key = JSON.stringify(options);
	let svg = byOptions.get(key);
	if (!svg) byOptions.set(key, (svg = vectorize(input, options)));
	return svg;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** Potrace's SVG, ready to nest inside ours. */
function nestable(svg: string): string {
	return svg.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/i, "");
}

function bladesPathData(blades: Vec[][]): string {
	return blades
		.map((pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`)
		.join("");
}

/** Tapered grass blades grow out of the letters' edges where the user pressed. */
async function render({ input, params, state, rng }: RenderContext<Params, State>) {
	const blades = allBlades(input, params, state, rng);
	const color = rgbToHex(inkColor(input));

	const canvas = rasterToCanvas(input);
	const ctx = context2d(canvas);
	ctx.fillStyle = color;
	ctx.beginPath();
	for (const pts of blades) {
		ctx.moveTo(pts[0][0], pts[0][1]);
		for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
		ctx.closePath();
	}
	ctx.fill("nonzero");
	const raster = ctx.getImageData(0, 0, input.width, input.height);

	const traceOptions: VectorizeOptions = {
		threshold: params.threshold,
		speckle: params.speckle,
		smoothness: TRACE_SMOOTHNESS,
		tolerance: TRACE_TOLERANCE,
	};
	// Built only on export: tracing every preview frame would stall the live preview.
	const svg = async () => {
		const W = input.width;
		const H = input.height;
		return (
			`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
			nestable(await traceInk(input, traceOptions)) +
			(blades.length > 0 ? `<path d="${bladesPathData(blades)}" fill="${color}"/>` : "") +
			`</svg>`
		);
	};
	return { raster, svg };
}

/** A press lives where its brush was: its center and a ring at the brush radius. */
function pressSamples(press: Press): { x: number; y: number }[] {
	const out = [{ x: press.x, y: press.y }];
	for (let k = 0; k < 8; k++) {
		const a = (k * Math.PI) / 4;
		out.push({
			x: press.x + Math.cos(a) * press.radius,
			y: press.y + Math.sin(a) * press.radius,
		});
	}
	return out;
}

/** A press goes with its letter, and away with it when the letter is deleted. */
function remapState(state: State, remap: Remap): State {
	return {
		...state,
		presses: remapItems(state.presses, remap, {
			samples: pressSamples,
			dropAbove: 0.5,
			// The first sample is the press's center.
			move: (press, [{ to }]) => ({
				...press,
				x: to.x,
				y: to.y,
				radius: press.radius * remap.scale,
			}),
		}),
	};
}

// ---------------------------------------------------------------------------
// Interface Break

/** How long grass on the interface waits, once the press ends, before its Workers set out, in ms. */
const WORKER_DELAY_MS = 400;
/** How long the Workers work on it once they're all there, in ms. */
const WORK_MS = 1200;

/** Whether a brush (image px) reaches past the Canvas on screen. */
function brushLeavesCanvas(
	toScreen: DOMMatrixReadOnly,
	canvas: DOMRectReadOnly,
	x: number,
	y: number,
	radius: number,
): boolean {
	const c = toScreen.transformPoint(new DOMPoint(x, y));
	const r = radius * toScreen.a;
	return (
		c.x - r < canvas.left ||
		c.x + r > canvas.right ||
		c.y - r < canvas.top ||
		c.y + r > canvas.bottom
	);
}

/** How far past the Canvas's edge a Worker stands for a brush centered on it, in screen px. */
const CREW_OUTSIDE_PX = 12;
/**
 * Workers stand on a screen grid this many px apart, one at each point a
 * brush covers off the Canvas: bigger brushes bring more of them. A shared
 * grid, so overlapping brushes share their Workers.
 */
const CREW_GRID_PX = 64;

/**
 * Presses whose brush reaches past the Canvas grow grass on the interface
 * too: in a snapshot of it, blades grow out of the interface's own ink (its
 * dark pixels: text, borders) just as out of the letters, as densely along
 * its edges; on the Canvas, the patch leaves them out. Each press gets the
 * same random stream as in render.
 */
function grassInterface(
	toScreen: DOMMatrixReadOnly,
	canvas: DOMRectReadOnly,
	snapshot: Promise<InterfaceSnapshot | null>,
	params: Params,
	seed: number,
): SnapshotBreak<Press[]> {
	const toViewport = (p: Press) => {
		const c = toScreen.transformPoint(new DOMPoint(p.x, p.y));
		return { x: c.x, y: c.y };
	};
	const reachesOut = (p: Press) =>
		brushLeavesCanvas(toScreen, canvas, p.x, p.y, p.radius);
	/** Where a Worker goes for a press: its center, or just off the Canvas's nearest edge. */
	const crewSpot = (p: Press) => {
		const c = toViewport(p);
		const inside =
			c.x >= canvas.left &&
			c.x < canvas.right &&
			c.y >= canvas.top &&
			c.y < canvas.bottom;
		if (!inside) return c;
		const out = CREW_OUTSIDE_PX;
		const edges = [
			{ d: c.x - canvas.left, x: canvas.left - out, y: c.y },
			{ d: canvas.right - c.x, x: canvas.right + out, y: c.y },
			{ d: c.y - canvas.top, x: c.x, y: canvas.top - out },
			{ d: canvas.bottom - c.y, x: c.x, y: canvas.bottom + out },
		];
		const e = edges.reduce((a, b) => (b.d < a.d ? b : a));
		return { x: e.x, y: e.y };
	};
	return snapshotBreak<Press[]>({
		snapshot,
		toScreen,
		canvas,
		holes: "paper",
		delayMs: WORKER_DELAY_MS,
		workMs: WORK_MS,
		crew: (presses) => {
			const spots = new Map<string, { x: number; y: number }>();
			for (const p of presses.filter(reachesOut)) {
				const c = toViewport(p);
				const r = p.radius * toScreen.a;
				const g = CREW_GRID_PX;
				let found = false;
				for (let gy = Math.ceil((c.y - r) / g) * g; gy <= c.y + r; gy += g) {
					for (let gx = Math.ceil((c.x - r) / g) * g; gx <= c.x + r; gx += g) {
						if (Math.hypot(gx - c.x, gy - c.y) > r) continue;
						const onCanvas =
							gx >= canvas.left &&
							gx < canvas.right &&
							gy >= canvas.top &&
							gy < canvas.bottom;
						if (onCanvas) continue;
						spots.set(`${gx},${gy}`, { x: gx, y: gy });
						found = true;
					}
				}
				// A brush too small to cover a grid point still gets one.
				if (!found) {
					const s = crewSpot(p);
					spots.set(`${s.x},${s.y}`, s);
				}
			}
			return [...spots.values()];
		},
		render: (snap, presses) => {
			// The presses reaching past the Canvas, and all sizes, in snapshot px. The
			// rate is per px of edge, so it's scaled down to keep the density.
			const k = toScreen.a * snap.scale;
			const off = presses
				.filter(reachesOut)
				.map((p) => ({
					...p,
					...toSnapshot(snap, toScreen, p.x, p.y),
					radius: p.radius * k,
					rate: p.rate / k,
				}));
			const scaled: Params = {
				...params,
				minLength: params.minLength * k,
				maxLength: params.maxLength * k,
				baseWidth: params.baseWidth * k,
			};
			const reach =
				Math.max(scaled.minLength, scaled.maxLength) + scaled.baseWidth + 2;
			const box = snapshotBox(
				snap,
				off.map((p) => ({ x: p.x, y: p.y, r: p.radius + reach })),
			);
			if (!box) return null;
			const { x0, y0, w, h } = box;
			const crop = cropPixels(snap.pixels, x0, y0, w, h);
			const ink = interfaceInk(crop);
			const rng = createRng(seed);
			const blades = off.flatMap((press) =>
				pressBlades(
					ink,
					{ ...press, x: press.x - x0, y: press.y - y0 },
					scaled,
					rng.fork(`press-${press.id}`),
				),
			);
			const ctx = context2d(rasterToCanvas(crop));
			// The interface's own ink color (averaging its pixels would pick up the paper).
			ctx.fillStyle =
				getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() ||
				"#000";
			ctx.beginPath();
			for (const pts of blades) {
				ctx.moveTo(pts[0][0], pts[0][1]);
				for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
				ctx.closePath();
			}
			ctx.fill("nonzero");
			return { pixels: ctx.getImageData(0, 0, w, h), x: x0, y: y0 };
		},
	});
}

// ---------------------------------------------------------------------------
// Editor

interface Gesture {
	done: Press[];
	/** Current press in image pixels; `start` is a performance.now() timestamp. */
	current: { x: number; y: number; start: number; id: number };
	/** Growth settings at the start of the gesture, copied into each of its presses. */
	growth: Tools;
	/** Image px → viewport px, and the Canvas on screen, from the press. */
	toScreen: DOMMatrixReadOnly;
	canvas: DOMRectReadOnly;
	/** The interface as it was at the press, for growing on it if the drag leaves the Canvas. */
	snapshot: Promise<InterfaceSnapshot | null>;
	/** Once the drag has left the Canvas: the grass on the interface. */
	interfaceGrass: SnapshotBreak<Press[]> | null;
}

function GrassEditor({
	input,
	params,
	state,
	setState,
	tools,
	seed,
	assets,
}: EditorProps<Params, State, Tools>) {
	const gesture = useRef<Gesture | null>(null);
	const [live, setLive] = useState<Press[] | null>(null);
	const [holding, setHolding] = useState(false);
	// Where the brush is, and image px → viewport px there: it's drawn over the
	// whole interface, since it may reach past the Canvas.
	const [hover, setHover] = useState<{
		p: ImagePoint;
		toScreen: DOMMatrixReadOnly;
	} | null>(null);

	const shownState = useMemo(
		() => (live ? { ...state, presses: [...state.presses, ...live] } : state),
		[state, live],
	);
	const result = useRender(render, input, params, shownState, seed, assets);

	const snapshot = (now: number): Press[] => {
		const g = gesture.current!;
		return [
			...g.done,
			{
				...g.growth,
				id: g.current.id,
				x: g.current.x,
				y: g.current.y,
				duration: (now - g.current.start) / 1000,
			},
		];
	};

	// While held, advance the in-progress presses each time the previous render
	// lands. Updating faster would make useRender drop every result as stale.
	useEffect(() => {
		if (!holding || result.pending) return;
		const id = requestAnimationFrame(() => {
			const g = gesture.current;
			if (!g) return;
			const presses = snapshot(performance.now());
			setLive(presses);
			g.interfaceGrass?.update(presses);
		});
		return () => cancelAnimationFrame(id);
	}, [holding, result]);
	// Grass on the interface still growing when the editor goes away: let it be cleared.
	useEffect(() => () => gesture.current?.interfaceGrass?.settle(), []);

	/** Once the current press's brush reaches past the Canvas, the grass breaks the interface too. */
	const breakIfOut = (g: Gesture) => {
		if (g.interfaceGrass) return;
		const { x, y } = g.current;
		if (!brushLeavesCanvas(g.toScreen, g.canvas, x, y, g.growth.radius)) return;
		g.interfaceGrass = grassInterface(g.toScreen, g.canvas, g.snapshot, params, seed);
	};

	const onDown = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		gesture.current = {
			done: [],
			current: { ...p, start: performance.now(), id: randomSeed() },
			growth: tools,
			toScreen: imageToScreen(e.currentTarget),
			canvas: e.currentTarget.getBoundingClientRect(),
			snapshot: snapshotInterface(),
			interfaceGrass: null,
		};
		breakIfOut(gesture.current);
		setLive(snapshot(performance.now()));
		setHolding(true);
	};

	// Dragging paints a trail: a new press starts every so often along the way.
	const onMove = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		setHover({ p, toScreen: imageToScreen(e.currentTarget) });
		const g = gesture.current;
		if (!g) return;
		const spacing = Math.max(2, g.growth.radius * TRAIL_SPACING);
		if (Math.hypot(p.x - g.current.x, p.y - g.current.y) < spacing) return;
		const now = performance.now();
		g.done = snapshot(now);
		g.current = { ...p, start: now, id: randomSeed() };
		breakIfOut(g);
	};

	const onUp = (_: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		// Released off the Canvas: nothing to hover anymore.
		if (!isOnCanvas(e)) setHover(null);
		const g = gesture.current;
		if (!g) return;
		const presses = snapshot(performance.now());
		gesture.current = null;
		if (g.interfaceGrass) {
			g.interfaceGrass.update(presses);
			g.interfaceGrass.settle();
		}
		setState((s) => ({ ...s, presses: [...s.presses, ...presses] }));
		setLive(null);
		setHolding(false);
	};

	return (
		<>
			<RasterView
				// Output is the same size as input, so image coords map 1:1.
				image={result.output?.raster ?? input}
				cursor="crosshair"
				onPointerDown={onDown}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onPointerLeave={() => setHover(null)}
			/>
			{hover && (
				<ScreenOverlay toScreen={hover.toScreen}>
					<circle
						cx={hover.p.x}
						cy={hover.p.y}
						r={tools.radius}
						fill="none"
						stroke="#30a46c"
						strokeWidth={1.5}
						vectorEffect="non-scaling-stroke"
					/>
				</ScreenOverlay>
			)}
			<OutputStatus result={result} />
		</>
	);
}

export const grass = defineManipulation({
	id: "grass",
	version: 1,
	label: "Grass",
	paramsSchema,
	stateSchema,
	toolsSchema,
	render,
	remapState,
	Component: GrassEditor,
});
