import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { z } from "zod";
import { blurMargin, gaussianBlur } from "../core/blur";
import { booleanField, numberField } from "../core/fields";
import { candidatesAround } from "../core/candidates";
import {
	defineManipulation,
	type EditorProps,
	type RenderContext,
} from "../core/manipulation";
import { context2d, rasterToCanvas } from "../core/raster";
import { remapItems, type Remap } from "../core/remap";
import { createRng, randomSeed, type Rng } from "../core/rng";
import { useRender } from "../core/useRender";
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
import {
	vectorize,
	vectorizeOptionsSchema,
	type VectorizeOptions,
} from "../vectorize/vectorize";

/** Trace settings for the SVG Output that aren't exposed as Params. */
const TRACE_SMOOTHNESS = 1;
const TRACE_TOLERANCE = 0.2;
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
/** Goo threshold and edge softness, as in the Goo Manipulation. */
const GOO_THRESHOLD = 0.5;
const GOO_SOFTNESS = 0.03;

const paramsSchema = z.object({
	ringWidth: numberField({
		label: "Ring width (px)",
		min: 0.5,
		max: 5,
		step: 0.5,
		default: 2.1,
	}),
	fullyOpaque: booleanField({ label: "Fully opaque rings", default: false }),
	gooRadius: numberField({
		label: "Goo radius (px)",
		min: 0,
		max: 5,
		step: 0.5,
		default: 1.6,
		hint: "Melts nearby rings together; 0 = off. Lone rings thinner than ~2.5× this vanish",
	}),
	minRadius: numberField({
		label: "Min radius (px)",
		min: 0.5,
		max: 200,
		step: 0.5,
		default: 3,
	}),
	maxRadius: numberField({
		label: "Max radius (px)",
		min: 1,
		max: 300,
		step: 0.5,
		default: 15,
	}),
	// Native SVG Output traces the original ink, so the trace settings live in the Recipe.
	threshold: vectorizeOptionsSchema.shape.threshold,
	speckle: vectorizeOptionsSchema.shape.speckle,
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
		step: 0.05,
		default: 1.3,
		hint: "How much slower the acid crosses paper than ink; 1 = no slowdown",
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
 * Presses in input pixels. `duration` is how long, in seconds, the pointer
 * stayed at that press (dwell time). Each press carries the acid settings it
 * was made with. `id` picks the press's random stream, so removing one press
 * doesn't change the others.
 */
const stateSchema = z.object({
	presses: z
		.array(
			acidSchema.extend({
				id: z.number().int().optional(),
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
	/** Current radius of the ring's centerline. */
	r: number;
	/** Radius the bubble grows to; used to decide whether it fits in the raster. */
	rMax: number;
	rgb: [number, number, number];
	alpha: number;
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
 * Candidate bubbles are a Poisson process in time around the press (see
 * candidatesAround): each draws its birth time, position and radius from
 * `rng`, whatever the press's duration. They're laid out in the press's own
 * frame, so when the press moves with its letter, its bubbles move with it.
 * A candidate becomes a bubble if it lands on ink the front had already
 * reached at its birth time. Because the stream of candidates
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
	const { ringWidth, fullyOpaque } = params;
	const minR = Math.min(params.minRadius, params.maxRadius);
	const maxR = Math.max(params.minRadius, params.maxRadius);
	const duration = press.duration;

	const maxDist = speed * Math.sqrt(duration);
	const field = distanceField(input, press.x, press.y, maxDist, paperSlowdown);
	// The decaying rate is applied by thinning (keeping each candidate with
	// probability rate(t) / spawnRate), which keeps generation prefix-stable.
	const candidates = candidatesAround(
		rng,
		press.x,
		press.y,
		maxDist + 1,
		spawnRate / 1000,
		duration,
	);
	const bubbles: Bubble[] = [];

	for (const { t, x, y, sizeDraw, keep } of candidates) {
		if (bubbles.length >= MAX_BUBBLES_PER_PRESS) break;
		if (keep >= 2 ** (-t / SPAWN_HALF_LIFE)) continue;
		const rMax = minR + sizeDraw * (maxR - minR) * 2 ** (-t / RADIUS_HALF_LIFE);
		const ix = Math.floor(x);
		const iy = Math.floor(y);
		if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
		const p = (iy * W + ix) * 4;
		if (a[p + 3] < INK_ALPHA) continue;
		const fx = ix - field.x0;
		const fy = iy - field.y0;
		if (fx < 0 || fy < 0 || fx >= field.w || fy >= field.h) continue;
		if (field.dist[fy * field.w + fx] > speed * Math.sqrt(t)) continue;
		// Skip bubbles that would cross the raster edge once fully grown.
		const outer = rMax + ringWidth / 2;
		if (x - outer < 0 || y - outer < 0 || x + outer > W || y + outer > H)
			continue;

		const age = growTime > 0 ? Math.min(1, (duration - t) / growTime) : 1;
		const eased = 1 - (1 - age) * (1 - age);
		bubbles.push({
			x,
			y,
			r: rMax * eased,
			rMax,
			rgb: [a[p], a[p + 1], a[p + 2]],
			alpha: fullyOpaque ? 1 : a[p + 3] / 255,
		});
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
		pressBubbles(input, press, params, rng.fork(`press-${press.id ?? i}`)),
	);
}

// ---------------------------------------------------------------------------
// Ring geometry, shared by the raster and the SVG Output

/**
 * Ring width at angle θ. Constant for now; the ring is built as an outer and
 * an inner contour so the width can vary along it later.
 */
function ringWidthAt(_theta: number, width: number): number {
	return width;
}

/** Outer and inner contours of a ring; `inner` is empty when the ring is a solid dot. */
function ringContours(
	b: Bubble,
	width: number,
): { outer: number[]; inner: number[] } {
	const n = Math.max(16, Math.ceil((2 * Math.PI * (b.r + width)) / 2));
	const outer: number[] = [];
	const inner: number[] = [];
	let solid = true;
	for (let k = 0; k < n; k++) {
		const theta = (k / n) * 2 * Math.PI;
		const half = ringWidthAt(theta, width) / 2;
		const cos = Math.cos(theta);
		const sin = Math.sin(theta);
		outer.push(b.x + (b.r + half) * cos, b.y + (b.r + half) * sin);
		const ri = b.r - half;
		if (ri > 0) solid = false;
		inner.push(b.x + Math.max(0, ri) * cos, b.y + Math.max(0, ri) * sin);
	}
	return { outer, inner: solid ? [] : inner };
}

/** Radius of the disk a bubble clears from earlier rings before its own ring is drawn. */
function clearRadius(b: Bubble, width: number): number {
	return b.r + width / 2;
}

/**
 * Radius of the disk a bubble eats out of the ink: the ring's centerline, so
 * the ink runs under the ring's outer half. Clearing up to the ring's outer
 * edge instead left a transparent seam between ink and ring, from the two
 * anti-aliased edges meeting, and wider with goo, which thins a ring
 * symmetrically around its centerline.
 */
function inkClearRadius(b: Bubble): number {
	return b.r;
}

// ---------------------------------------------------------------------------
// Output

/** Path of a ring's two contours, for an `evenodd` fill. */
function ringPath(
	ctx: OffscreenCanvasRenderingContext2D,
	b: Bubble,
	width: number,
) {
	const { outer, inner } = ringContours(b, width);
	ctx.beginPath();
	for (const contour of [outer, inner]) {
		for (let k = 0; k < contour.length; k += 2) {
			if (k === 0) ctx.moveTo(contour[k], contour[k + 1]);
			else ctx.lineTo(contour[k], contour[k + 1]);
		}
		ctx.closePath();
	}
}

/**
 * The foam: rings drawn in order on a transparent layer, each first clearing
 * its disk, so a later bubble cuts away the earlier rings inside it.
 */
function drawRings(
	W: number,
	H: number,
	bubbles: Bubble[],
	width: number,
	fill: (b: Bubble) => string,
): ImageData {
	const canvas = new OffscreenCanvas(W, H);
	const ctx = context2d(canvas);
	for (const b of bubbles) {
		ctx.globalCompositeOperation = "destination-out";
		ctx.beginPath();
		ctx.arc(b.x, b.y, clearRadius(b, width), 0, 2 * Math.PI);
		ctx.fill();
		ctx.globalCompositeOperation = "source-over";
		ctx.fillStyle = fill(b);
		ringPath(ctx, b, width);
		ctx.fill("evenodd");
	}
	return ctx.getImageData(0, 0, W, H);
}

/**
 * Goo the ring layer: blur, then threshold the coverage back into crisp
 * shapes, so nearby rings melt together. Colours and the rings' own alpha are
 * blurred along with the coverage (weighted by it), so merged areas blend the
 * colours of the rings that meet there.
 */
function gooRings(
	W: number,
	H: number,
	bubbles: Bubble[],
	width: number,
	gooRadius: number,
): ImageData {
	// Shape and colour, drawn opaque so coverage isn't mixed with ring alpha.
	const color = drawRings(
		W,
		H,
		bubbles,
		width,
		(b) => `rgb(${b.rgb.join(",")})`,
	);
	const translucent = bubbles.some((b) => b.alpha < 1);
	const alpha = translucent
		? drawRings(W, H, bubbles, width, (b) => {
				const v = Math.round(b.alpha * 255);
				return `rgb(${v},${v},${v})`;
			})
		: null;

	// Only blur the area the bubbles (plus the blur's reach) can touch.
	const margin = blurMargin(gooRadius);
	let x0 = W;
	let y0 = H;
	let x1 = 0;
	let y1 = 0;
	for (const b of bubbles) {
		const r = clearRadius(b, width);
		x0 = Math.min(x0, Math.floor(b.x - r));
		y0 = Math.min(y0, Math.floor(b.y - r));
		x1 = Math.max(x1, Math.ceil(b.x + r));
		y1 = Math.max(y1, Math.ceil(b.y + r));
	}
	const out = new ImageData(W, H);
	if (x1 <= x0) return out;
	x0 = Math.max(0, x0 - margin);
	y0 = Math.max(0, y0 - margin);
	x1 = Math.min(W, x1 + margin);
	y1 = Math.min(H, y1 + margin);
	const w = x1 - x0;
	const h = y1 - y0;

	const cov = new Float32Array(w * h);
	const channels = [0, 1, 2, 3].map(() => new Float32Array(w * h));
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const p = ((y0 + y) * W + x0 + x) * 4;
			const c = color.data[p + 3] / 255;
			cov[i] = c;
			channels[0][i] = color.data[p] * c;
			channels[1][i] = color.data[p + 1] * c;
			channels[2][i] = color.data[p + 2] * c;
			channels[3][i] = (alpha ? alpha.data[p] / 255 : 1) * c;
		}
	}
	const s = gaussianBlur(cov, w, h, gooRadius);
	const [r, g, bl, a] = channels.map((ch) => gaussianBlur(ch, w, h, gooRadius));

	const lo = GOO_THRESHOLD - GOO_SOFTNESS / 2;
	const hi = GOO_THRESHOLD + GOO_SOFTNESS / 2;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const v = s[i];
			if (v <= 0) continue;
			const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
			const shape = t * t * (3 - 2 * t);
			if (shape <= 0) continue;
			const p = ((y0 + y) * W + x0 + x) * 4;
			out.data[p] = r[i] / v;
			out.data[p + 1] = g[i] / v;
			out.data[p + 2] = bl[i] / v;
			out.data[p + 3] = Math.round(shape * (a[i] / v) * 255);
		}
	}
	return out;
}

/** The ink with every bubble's disk eaten away, then the (gooed) foam on top. */
function renderRaster(
	input: ImageData,
	bubbles: Bubble[],
	width: number,
	gooRadius: number,
): { raster: ImageData; rings: ImageData } {
	const W = input.width;
	const H = input.height;
	const rings =
		gooRadius > 0
			? gooRings(W, H, bubbles, width, gooRadius)
			: drawRings(
					W,
					H,
					bubbles,
					width,
					(b) => `rgba(${b.rgb[0]}, ${b.rgb[1]}, ${b.rgb[2]}, ${b.alpha})`,
				);

	const canvas = rasterToCanvas(input);
	const ctx = context2d(canvas);
	ctx.globalCompositeOperation = "destination-out";
	for (const b of bubbles) {
		ctx.beginPath();
		ctx.arc(b.x, b.y, inkClearRadius(b), 0, 2 * Math.PI);
		ctx.fill();
	}
	ctx.globalCompositeOperation = "source-over";
	ctx.drawImage(rasterToCanvas(rings), 0, 0);
	return { raster: ctx.getImageData(0, 0, W, H), rings };
}

/**
 * Pure memo of the trace of an input: the same input and options always give
 * the same SVG, so caching doesn't affect determinism. It keeps the live
 * preview from re-tracing the original ink every frame.
 */
const traceCache = new WeakMap<ImageData, Map<string, Promise<string>>>();

function traceInk(
	input: ImageData,
	options: VectorizeOptions,
): Promise<string> {
	let byOptions = traceCache.get(input);
	if (!byOptions) traceCache.set(input, (byOptions = new Map()));
	const key = JSON.stringify(options);
	let svg = byOptions.get(key);
	if (!svg) byOptions.set(key, (svg = vectorize(input, options)));
	return svg;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

function circle(b: Bubble, r: number, fill: string): string {
	return `<circle cx="${f(b.x)}" cy="${f(b.y)}" r="${f(r)}" fill="${fill}"/>`;
}

/** Potrace's SVG, ready to nest inside ours. */
function nestable(svg: string): string {
	return svg.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/i, "");
}

/**
 * The original ink, masked by every bubble's interior, then the rings. Without
 * goo, each ring is an exact path, masked by the interiors of the later
 * bubbles that overlap it (the foam-cell look). With goo, the rings are no
 * longer circles, so `tracedRings` (the traced gooed ring layer) replaces them.
 */
function renderSvg(
	input: ImageData,
	traced: string,
	tracedRings: string | null,
	bubbles: Bubble[],
	width: number,
): string {
	const W = input.width;
	const H = input.height;
	const defs: string[] = [];
	const body: string[] = [];

	defs.push(
		`<mask id="ink" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
			`<rect width="${W}" height="${H}" fill="white"/>` +
			bubbles.map((b) => circle(b, inkClearRadius(b), "black")).join("") +
			`</mask>`,
	);
	body.push(`<g mask="url(#ink)">${nestable(traced)}</g>`);
	if (tracedRings !== null) {
		body.push(nestable(tracedRings));
		return wrapSvg(W, H, defs, body);
	}

	// Spatial grid so each ring only checks nearby bubbles for overlap.
	const maxOuter = bubbles.reduce(
		(m, b) => Math.max(m, clearRadius(b, width)),
		0,
	);
	const cell = Math.max(1, 2 * maxOuter);
	const grid = new Map<string, number[]>();
	bubbles.forEach((b, i) => {
		const k = `${Math.floor(b.x / cell)},${Math.floor(b.y / cell)}`;
		const list = grid.get(k);
		if (list) list.push(i);
		else grid.set(k, [i]);
	});

	bubbles.forEach((b, i) => {
		const ro = clearRadius(b, width);
		const cx = Math.floor(b.x / cell);
		const cy = Math.floor(b.y / cell);
		const later: Bubble[] = [];
		for (let gy = cy - 1; gy <= cy + 1; gy++) {
			for (let gx = cx - 1; gx <= cx + 1; gx++) {
				for (const j of grid.get(`${gx},${gy}`) ?? []) {
					if (j <= i) continue;
					const o = bubbles[j];
					if (Math.hypot(o.x - b.x, o.y - b.y) < ro + clearRadius(o, width))
						later.push(o);
				}
			}
		}
		let maskAttr = "";
		if (later.length > 0) {
			const id = `b${i}`;
			const x = b.x - ro;
			const y = b.y - ro;
			defs.push(
				`<mask id="${id}" maskUnits="userSpaceOnUse" x="${f(x)}" y="${f(y)}" width="${f(2 * ro)}" height="${f(2 * ro)}">` +
					`<rect x="${f(x)}" y="${f(y)}" width="${f(2 * ro)}" height="${f(2 * ro)}" fill="white"/>` +
					later.map((o) => circle(o, clearRadius(o, width), "black")).join("") +
					`</mask>`,
			);
			maskAttr = ` mask="url(#${id})"`;
		}

		const { outer, inner } = ringContours(b, width);
		const d = [outer, inner]
			.filter((c) => c.length > 0)
			.map((c) => {
				let s = `M${f(c[0])} ${f(c[1])}`;
				for (let k = 2; k < c.length; k += 2) s += `L${f(c[k])} ${f(c[k + 1])}`;
				return s + "Z";
			})
			.join("");
		const opacity = b.alpha < 1 ? ` fill-opacity="${f(b.alpha)}"` : "";
		body.push(
			`<path d="${d}" fill="rgb(${b.rgb.join(",")})"${opacity} fill-rule="evenodd"${maskAttr}/>`,
		);
	});

	return wrapSvg(W, H, defs, body);
}

function wrapSvg(W: number, H: number, defs: string[], body: string[]): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
		`<defs>${defs.join("")}</defs>${body.join("")}</svg>`
	);
}

/** The ink bubbles where the user pressed; the bubbles eat into the letters as they spread. */
async function render({
	input,
	params,
	state,
	rng,
}: RenderContext<Params, State>) {
	const bubbles = allBubbles(input, params, state, rng);
	const { raster, rings } = renderRaster(
		input,
		bubbles,
		params.ringWidth,
		params.gooRadius,
	);
	const traceOptions: VectorizeOptions = {
		threshold: params.threshold,
		speckle: params.speckle,
		smoothness: TRACE_SMOOTHNESS,
		tolerance: TRACE_TOLERANCE,
	};
	// Built only on export: tracing every preview frame would stall the live preview.
	const svg = async () =>
		renderSvg(
			input,
			await traceInk(input, traceOptions),
			params.gooRadius > 0 ? await vectorize(rings, traceOptions) : null,
			bubbles,
			params.ringWidth,
		);
	return { raster, svg };
}

/** Points a press's acid may reach: its center, and rings at half and full reach. */
function pressSamples(press: Press): { x: number; y: number }[] {
	const reach = press.speed * Math.sqrt(press.duration);
	const out = [{ x: press.x, y: press.y }];
	for (const f of [0.5, 1]) {
		for (let k = 0; k < 8; k++) {
			const a = (k * Math.PI) / 4;
			out.push({
				x: press.x + Math.cos(a) * reach * f,
				y: press.y + Math.sin(a) * reach * f,
			});
		}
	}
	return out;
}

/**
 * A press goes with its letter, its bubbles with it. A press whose acid
 * reached mostly letters that were deleted goes away with them.
 */
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
				speed: press.speed * remap.scale,
			}),
		}),
	};
}

// ---------------------------------------------------------------------------
// Editor

// ---------------------------------------------------------------------------
// Interface Break

/** How long acid on the interface waits, once the press ends, before its Workers set out, in ms. */
const WORKER_DELAY_MS = 400;
/** How long the Workers work on it once they're all there, in ms. */
const WORK_MS = 1200;

/**
 * Presses dragged off the Canvas foam on the interface too: in a snapshot of
 * it, the acid spreads from each through the interface's own ink (its dark
 * pixels), eating it and leaving rings there just as on the letters. Each
 * press gets the same random stream as in render.
 */
function acidInterface(
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
	const onCanvas = (p: Press) => {
		const c = toViewport(p);
		return (
			c.x >= canvas.left &&
			c.x < canvas.right &&
			c.y >= canvas.top &&
			c.y < canvas.bottom
		);
	};
	return snapshotBreak<Press[]>({
		snapshot,
		toScreen,
		canvas,
		holes: "paper",
		delayMs: WORKER_DELAY_MS,
		workMs: WORK_MS,
		crew: (presses) => presses.map(toViewport),
		render: (snap, presses) => {
			// The presses off the Canvas, and all sizes, in snapshot px.
			const k = toScreen.a * snap.scale;
			const off = presses
				.filter((p) => !onCanvas(p))
				.map((p) => ({ ...p, ...toSnapshot(snap, toScreen, p.x, p.y), speed: p.speed * k }));
			const scaled: Params = {
				...params,
				ringWidth: params.ringWidth * k,
				gooRadius: params.gooRadius * k,
				minRadius: params.minRadius * k,
				maxRadius: params.maxRadius * k,
			};
			const margin =
				Math.max(scaled.minRadius, scaled.maxRadius) +
				scaled.ringWidth +
				blurMargin(scaled.gooRadius) +
				2;
			const box = snapshotBox(
				snap,
				off.map((p) => ({ x: p.x, y: p.y, r: p.speed * Math.sqrt(p.duration) + margin })),
			);
			if (!box) return null;
			const { x0, y0, w, h } = box;
			const crop = cropPixels(snap.pixels, x0, y0, w, h);
			const ink = interfaceInk(crop);
			const rng = createRng(seed);
			const bubbles = off.flatMap((press, i) =>
				pressBubbles(
					ink,
					{ ...press, x: press.x - x0, y: press.y - y0 },
					scaled,
					rng.fork(`press-${press.id ?? i}`),
				),
			);
			const { raster } = renderRaster(crop, bubbles, scaled.ringWidth, scaled.gooRadius);
			return { pixels: raster, x: x0, y: y0 };
		},
	});
}

// ---------------------------------------------------------------------------
// Editor

interface Gesture {
	done: Press[];
	/**
	 * Current press in image pixels; `start` is a performance.now() timestamp,
	 * `id` the press's id, fixed so the preview matches the committed press.
	 */
	current: { x: number; y: number; start: number; id: number };
	/** Acid settings at the start of the gesture, copied into each of its presses. */
	acid: Tools;
	/** Image px → viewport px, and the Canvas on screen, from the press. */
	toScreen: DOMMatrixReadOnly;
	canvas: DOMRectReadOnly;
	/** The interface as it was at the press, for foaming on it if the drag leaves the Canvas. */
	snapshot: Promise<InterfaceSnapshot | null>;
	/** Once the drag has left the Canvas: the acid on the interface. */
	interfaceAcid: SnapshotBreak<Press[]> | null;
}

function BubblingAcidEditor({
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
			g.interfaceAcid?.update(presses);
		});
		return () => cancelAnimationFrame(id);
	}, [holding, result]);
	// Acid on the interface still foaming when the editor goes away: let it be fixed.
	useEffect(() => () => gesture.current?.interfaceAcid?.settle(), []);

	const onDown = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		gesture.current = {
			done: [],
			current: { ...p, start: performance.now(), id: randomSeed() },
			acid: tools,
			toScreen: imageToScreen(e.currentTarget),
			canvas: e.currentTarget.getBoundingClientRect(),
			snapshot: snapshotInterface(),
			interfaceAcid: null,
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
	const onMove = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		setHover(p);
		const g = gesture.current;
		if (!g) return;
		if (!g.interfaceAcid && !isOnCanvas(e))
			g.interfaceAcid = acidInterface(
				g.toScreen,
				g.canvas,
				g.snapshot,
				params,
				seed,
			);
		if (Math.hypot(p.x - g.current.x, p.y - g.current.y) < PRESS_SPACING)
			return;
		const now = performance.now();
		if (insideSpread(g, p, now)) return;
		g.done = snapshot(now);
		g.current = { ...p, start: now, id: randomSeed() };
		spread.current = null;
	};

	const onUp = () => {
		const g = gesture.current;
		if (!g) return;
		const presses = snapshot(performance.now());
		gesture.current = null;
		if (g.interfaceAcid) {
			g.interfaceAcid.update(presses);
			g.interfaceAcid.settle();
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

export const bubblingAcid = defineManipulation({
	id: "bubbling-acid",
	version: 2,
	label: "Bubbling Acid",
	paramsSchema,
	stateSchema,
	toolsSchema,
	render,
	remapState,
	Component: BubblingAcidEditor,
});
