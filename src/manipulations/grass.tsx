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
import { randomSeed, type Rng } from "../core/rng";
import { useRender } from "../core/useRender";
import {
	vectorize,
	vectorizeOptionsSchema,
	type VectorizeOptions,
} from "../vectorize/vectorize";
import { OutputStatus } from "../ui/OutputStatus";
import { RasterView, type ImagePoint } from "../ui/RasterView";

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
// Editor

interface Gesture {
	done: Press[];
	/** Current press in image pixels; `start` is a performance.now() timestamp. */
	current: { x: number; y: number; start: number; id: number };
	/** Growth settings at the start of the gesture, copied into each of its presses. */
	growth: Tools;
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
	const [hover, setHover] = useState<ImagePoint | null>(null);

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
			if (gesture.current) setLive(snapshot(performance.now()));
		});
		return () => cancelAnimationFrame(id);
	}, [holding, result]);

	const onDown = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		gesture.current = {
			done: [],
			current: { ...p, start: performance.now(), id: randomSeed() },
			growth: tools,
		};
		setLive(snapshot(performance.now()));
		setHolding(true);
	};

	// Dragging paints a trail: a new press starts every so often along the way.
	const onMove = (p: ImagePoint) => {
		setHover(p);
		const g = gesture.current;
		if (!g) return;
		const spacing = Math.max(2, g.growth.radius * TRAIL_SPACING);
		if (Math.hypot(p.x - g.current.x, p.y - g.current.y) < spacing) return;
		const now = performance.now();
		g.done = snapshot(now);
		g.current = { ...p, start: now, id: randomSeed() };
	};

	const onUp = () => {
		if (!gesture.current) return;
		const presses = snapshot(performance.now());
		gesture.current = null;
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
				overlay={
					hover && (
						<circle
							cx={hover.x}
							cy={hover.y}
							r={tools.radius}
							fill="none"
							stroke="#30a46c"
							strokeWidth={1.5}
							vectorEffect="non-scaling-stroke"
						/>
					)
				}
			/>
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
