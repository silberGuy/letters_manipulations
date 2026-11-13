import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { z } from "zod";
import { numberField } from "../core/fields";
import {
	defineManipulation,
	type EditorProps,
	type RenderContext,
} from "../core/manipulation";
import { PushCanvas } from "../core/push";
import type { Rng } from "../core/rng";
import { useRender } from "../core/useRender";
import { OutputStatus } from "../ui/OutputStatus";
import { RasterView, type ImagePoint } from "../ui/RasterView";

/** Cap on bubbles per press, so a very long press stays renderable. */
const MAX_BUBBLES_PER_PRESS = 2000;
/** How far (px) the pointer moves during a drag before a new press starts. */
const PRESS_SPACING = 8;
/**
 * The spawn rate halves every this many seconds of a press, so ink the acid
 * reaches later (farther from the press) gets thinner foam.
 */
const SPAWN_HALF_LIFE = 0.8;
/**
 * The span between min and max radius halves every this many seconds of a
 * press, so bubbles born later (farther from the press) are smaller, tending
 * towards the min radius.
 */
const RADIUS_HALF_LIFE = 1.5;
/** Pushed pixels fainter than this alpha are removed, so smeared ink doesn't leave a haze. */
const PUSHED_MIN_ALPHA = 0.3;

const paramsSchema = z.object({
	pushStrength: numberField({
		label: "Push strength",
		min: 0,
		max: 1.5,
		step: 0.05,
		default: 1,
		hint: "0 = plain holes; 1 = the ink inside each bubble is pushed out around it",
	}),
	reach: numberField({
		label: "Push reach (× radius)",
		min: 1,
		max: 7,
		step: 0.1,
		default: 4,
	}),
	minRadius: numberField({
		label: "Min radius (px)",
		min: 0.5,
		max: 200,
		step: 0.5,
		default: 2,
	}),
	maxRadius: numberField({
		label: "Max radius (px)",
		min: 1,
		max: 300,
		step: 0.5,
		default: 10,
	}),
});

/**
 * How the acid behaves from a press. Set as Tool settings and copied into each
 * press when it's made, so presses made with different settings keep them.
 */
const acidSchema = z.object({
	speed: numberField({
		label: "Spread speed (px/√s)",
		min: 1,
		max: 400,
		default: 40,
	}),
	paperSlowdown: numberField({
		label: "Slowdown over paper",
		min: 1,
		max: 5,
		step: 1,
		default: 2,
	}),
	spawnRate: numberField({
		label: "Spawn rate",
		min: 0.1,
		max: 50,
		step: 0.1,
		default: 30,
		hint: "Bubbles per 1000px² of reached ink per second, at the moment of pressing",
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
 * Presses in input-normalized coordinates. `duration` is how long, in seconds,
 * the pointer stayed at that press (dwell time). Each press carries the acid
 * settings it was made with.
 */
const stateSchema = z.object({
	presses: z
		.array(
			acidSchema.extend({
				x: z.number(),
				y: z.number(),
				duration: z.number().nonnegative(),
			}),
		)
		.default([]),
});

const toolsSchema = acidSchema;

type Params = z.output<typeof paramsSchema>;
type State = z.output<typeof stateSchema>;
type Tools = z.output<typeof toolsSchema>;
type Press = State["presses"][number];

/** A pixel is ink, so it can host a bubble center and carries the front at full speed, from 50% alpha. */
const INK_ALPHA = 128;

interface Bubble {
	x: number;
	y: number;
	/** Current radius of the hole. */
	r: number;
}

// ---------------------------------------------------------------------------
// Spread: a weighted distance field from the press point

/** Min-heap of pixel indices keyed by distance. */
class Heap {
	private idx: number[] = [];
	private key: number[] = [];
	get size() {
		return this.idx.length;
	}
	push(i: number, k: number) {
		const { idx, key } = this;
		let n = idx.length;
		idx.push(i);
		key.push(k);
		while (n > 0) {
			const p = (n - 1) >> 1;
			if (key[p] <= key[n]) break;
			[idx[p], idx[n]] = [idx[n], idx[p]];
			[key[p], key[n]] = [key[n], key[p]];
			n = p;
		}
	}
	pop(): [number, number] {
		const { idx, key } = this;
		const top: [number, number] = [idx[0], key[0]];
		const li = idx.pop()!;
		const lk = key.pop()!;
		if (idx.length > 0) {
			idx[0] = li;
			key[0] = lk;
			let n = 0;
			for (;;) {
				const l = n * 2 + 1;
				const r = l + 1;
				let m = n;
				if (l < idx.length && key[l] < key[m]) m = l;
				if (r < idx.length && key[r] < key[m]) m = r;
				if (m === n) break;
				[idx[m], idx[n]] = [idx[n], idx[m]];
				[key[m], key[n]] = [key[n], key[m]];
				n = m;
			}
		}
		return top;
	}
}

interface DistanceField {
	/** Box in image pixels; the field covers [x0, x0+w) × [y0, y0+h). */
	x0: number;
	y0: number;
	w: number;
	h: number;
	dist: Float64Array;
}

const NEIGHBORS: [number, number, number][] = [
	[1, 0, 1],
	[-1, 0, 1],
	[0, 1, 1],
	[0, -1, 1],
	[1, 1, Math.SQRT2],
	[1, -1, Math.SQRT2],
	[-1, 1, Math.SQRT2],
	[-1, -1, Math.SQRT2],
];

/**
 * How far the acid has to travel from (px, py) to reach each pixel. Ink costs
 * 1 per pixel, paper costs `paperSlowdown`. Since every step costs at least
 * its Euclidean length, nothing beyond `maxDist` of the press can be reached,
 * so the field only covers that box.
 */
function distanceField(
	input: ImageData,
	px: number,
	py: number,
	maxDist: number,
	paperSlowdown: number,
): DistanceField {
	const W = input.width;
	const H = input.height;
	const a = input.data;
	const sx = Math.min(W - 1, Math.max(0, Math.floor(px)));
	const sy = Math.min(H - 1, Math.max(0, Math.floor(py)));
	const reach = Math.ceil(maxDist) + 1;
	const x0 = Math.max(0, sx - reach);
	const y0 = Math.max(0, sy - reach);
	const w = Math.min(W, sx + reach + 1) - x0;
	const h = Math.min(H, sy + reach + 1) - y0;
	// Float64 to match the heap keys. With Float32 the rounded stored distances
	// break the `d > dist[i]` / `nd < dist[ni]` checks: pixels get re-pushed
	// dozens of times (~30× slower) and some are wrongly skipped, cutting the
	// spread short.
	const dist = new Float64Array(w * h).fill(Infinity);
	const cost = (x: number, y: number) =>
		a[((y0 + y) * W + x0 + x) * 4 + 3] >= INK_ALPHA ? 1 : paperSlowdown;

	const heap = new Heap();
	const start = (sy - y0) * w + (sx - x0);
	dist[start] = 0;
	heap.push(start, 0);
	while (heap.size > 0) {
		const [i, d] = heap.pop();
		if (d > dist[i]) continue;
		const x = i % w;
		const y = (i - x) / w;
		const c = cost(x, y);
		for (const [dx, dy, len] of NEIGHBORS) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
			const nd = d + (len * (c + cost(nx, ny))) / 2;
			const ni = ny * w + nx;
			if (nd <= maxDist && nd < dist[ni]) {
				dist[ni] = nd;
				heap.push(ni, nd);
			}
		}
	}
	return { x0, y0, w, h, dist };
}

// ---------------------------------------------------------------------------
// Bubble generation

/**
 * The bubbles of one press, in draw order.
 *
 * Candidate bubbles are a Poisson process in time over the *whole* image:
 * each draws its birth time, position and radius from `rng`, whatever the
 * press's duration. A candidate becomes a bubble if it lands on ink the front
 * had already reached at its birth time. Because the stream of candidates
 * doesn't depend on the duration, a longer press only appends bubbles to a
 * shorter one's list — so the live preview grows smoothly instead of
 * reshuffling every frame.
 */
function pressBubbles(
	input: ImageData,
	press: Press,
	params: Params,
	rng: Rng,
): Bubble[] {
	const W = input.width;
	const H = input.height;
	const a = input.data;
	const { speed, paperSlowdown, spawnRate, growTime } = press;
	const minR = Math.min(params.minRadius, params.maxRadius);
	const maxR = Math.max(params.minRadius, params.maxRadius);
	const duration = press.duration;

	const field = distanceField(
		input,
		press.x * W,
		press.y * H,
		speed * Math.sqrt(duration),
		paperSlowdown,
	);
	// Candidates per second over the whole image, at the initial spawn rate.
	// The decaying rate is applied by thinning (keeping each candidate with
	// probability rate(t) / spawnRate), which keeps generation prefix-stable.
	const rate = (spawnRate / 1000) * W * H;
	const bubbles: Bubble[] = [];

	let t = 0;
	for (;;) {
		// Draw every value of the candidate up front, so accepting or rejecting it
		// never shifts the draws of later candidates.
		t += -Math.log(1 - rng.next()) / rate;
		const x = rng.range(0, W);
		const y = rng.range(0, H);
		const sizeDraw = rng.next();
		const keep = rng.next();
		if (t > duration || bubbles.length >= MAX_BUBBLES_PER_PRESS) break;

		if (keep >= 2 ** (-t / SPAWN_HALF_LIFE)) continue;
		const rMax = minR + sizeDraw * (maxR - minR) * 2 ** (-t / RADIUS_HALF_LIFE);
		const ix = Math.floor(x);
		const iy = Math.floor(y);
		const p = (iy * W + ix) * 4;
		if (a[p + 3] < INK_ALPHA) continue;
		const fx = ix - field.x0;
		const fy = iy - field.y0;
		if (fx < 0 || fy < 0 || fx >= field.w || fy >= field.h) continue;
		if (field.dist[fy * field.w + fx] > speed * Math.sqrt(t)) continue;
		// Skip bubbles that would cross the raster edge once fully grown.
		if (x - rMax < 0 || y - rMax < 0 || x + rMax > W || y + rMax > H) continue;

		const age = growTime > 0 ? Math.min(1, (duration - t) / growTime) : 1;
		const eased = 1 - (1 - age) * (1 - age);
		bubbles.push({ x, y, r: rMax * eased });
	}
	return bubbles;
}

function allBubbles(
	input: ImageData,
	params: Params,
	state: State,
	rng: Rng,
): Bubble[] {
	// One independent stream per press, so editing or adding a press never
	// changes the bubbles of the others.
	return state.presses.flatMap((press, i) =>
		pressBubbles(input, press, params, rng.fork(`press-${i}`)),
	);
}

// ---------------------------------------------------------------------------
// Output

/**
 * The bubbles open one by one as holes that push the ink out around them,
 * so each bubble's own ink forms its rim and later bubbles squash earlier ones.
 */
async function render({
	input,
	params,
	state,
	rng,
}: RenderContext<Params, State>) {
	const canvas = new PushCanvas(input);
	for (const b of allBubbles(input, params, state, rng)) {
		if (b.r <= 0) continue;
		canvas.open(
			{ cx: b.x, cy: b.y, angle: 0, a: b.r, b: b.r, reach: params.reach },
			params.pushStrength,
		);
	}
	// No native SVG: export traces the raster, only when asked.
	return { raster: canvas.toImageData(PUSHED_MIN_ALPHA) };
}

// ---------------------------------------------------------------------------
// Editor

interface Gesture {
	done: Press[];
	/** Current press in image pixels; `start` is a performance.now() timestamp. */
	current: { x: number; y: number; start: number };
	/** Acid settings at the start of the gesture, copied into each of its presses. */
	acid: Tools;
}

function EatingAcidEditor({
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
				...g.acid,
				x: g.current.x / input.width,
				y: g.current.y / input.height,
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
			current: { ...p, start: performance.now() },
			acid: tools,
		};
		spread.current = null;
		setLive(snapshot(performance.now()));
		setHolding(true);
	};

	// The current press's spread, recomputed at most once per frame while dragging.
	const spread = useRef<{ at: number; field: DistanceField } | null>(null);

	/** Whether the current press's acid has reached image point p by `now`. */
	const insideSpread = (g: Gesture, p: ImagePoint, now: number): boolean => {
		if (!spread.current || now - spread.current.at > 16) {
			const elapsed = (now - g.current.start) / 1000;
			spread.current = {
				at: now,
				field: distanceField(
					input,
					g.current.x,
					g.current.y,
					g.acid.speed * Math.sqrt(elapsed),
					g.acid.paperSlowdown,
				),
			};
		}
		const f = spread.current.field;
		const fx = Math.floor(p.x) - f.x0;
		const fy = Math.floor(p.y) - f.y0;
		if (fx < 0 || fy < 0 || fx >= f.w || fy >= f.h) return false;
		return Number.isFinite(f.dist[fy * f.w + fx]);
	};

	// A drag keeps feeding the current press while the pointer stays inside its
	// spread, and starts a new press once it outruns the acid. PRESS_SPACING is a
	// floor, so jitter right after pressing doesn't start new presses.
	const onMove = (p: ImagePoint) => {
		setHover(p);
		const g = gesture.current;
		if (!g) return;
		if (Math.hypot(p.x - g.current.x, p.y - g.current.y) < PRESS_SPACING)
			return;
		const now = performance.now();
		if (insideSpread(g, p, now)) return;
		g.done = snapshot(now);
		g.current = { ...p, start: now };
		spread.current = null;
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
							r={PRESS_SPACING}
							fill="none"
							stroke="#e5484d"
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

export const eatingAcid = defineManipulation({
	id: "eating-acid",
	version: 1,
	label: "Eating Acid",
	paramsSchema,
	stateSchema,
	toolsSchema,
	render,
	Component: EatingAcidEditor,
});
