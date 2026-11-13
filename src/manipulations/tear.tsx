import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { z } from "zod";
import { numberField } from "../core/fields";
import {
	defineManipulation,
	type EditorProps,
	type RenderContext,
} from "../core/manipulation";
import { createRaster } from "../core/raster";
import type { Rng } from "../core/rng";
import { useRender } from "../core/useRender";
import { OutputStatus } from "../ui/OutputStatus";
import { RasterView, type ImagePoint } from "../ui/RasterView";

/** Min distance (px) between recorded points of a Cut. */
const POINT_SPACING = 3;
/** Cuts shorter than this (px) are dropped: a click has no direction to tear along. */
const MIN_CUT_LENGTH = 3;
/** An ellipse only opens where the ink under its center is at least this opaque. */
const INK_ALPHA = 0.5;
/** Ellipses with a smaller across-radius than this (px) are skipped. */
const MIN_RADIUS = 0.3;
/** Pushed pixels fainter than this alpha are removed, so smeared ink doesn't leave a haze. */
const PUSHED_MIN_ALPHA = 0.25;
/** After release, every ellipse keeps growing for this long (s)... */
const AFTER_GROW_TIME = 0.3;
/** ...to this much bigger than its size at release, as a fraction. */
const AFTER_GROW_AMOUNT = 0.15;

const paramsSchema = z.object({
	pushStrength: numberField({
		label: "Push strength",
		min: 0,
		max: 1,
		step: 0.05,
		default: 0.8,
		hint: "0 = plain holes; 1 = the ink inside each hole is pushed out around it",
	}),
});

const toolsSchema = z.object({
	width: numberField({
		label: "Tear width (px)",
		min: 2,
		max: 400,
		default: 31,
	}),
	aspect: numberField({
		label: "Aspect (along ÷ across)",
		min: 0.05,
		max: 1,
		step: 0.05,
		default: 0.35,
	}),
	radiusJitter: numberField({
		label: "Radius jitter (%)",
		min: 0,
		max: 100,
		default: 50,
	}),
	tiltJitter: numberField({
		label: "Tilt jitter (°)",
		min: 0,
		max: 20,
		default: 7,
	}),
	positionJitter: numberField({
		label: "Position jitter (px)",
		min: 0,
		max: 10,
		default: 3,
	}),
	spacing: numberField({
		label: "Spacing (% of width)",
		min: 3,
		max: 35,
		step: 0.1,
		// 6px at the default 31px width.
		default: (6 / 31) * 100,
	}),
	taper: numberField({
		label: "Taper (px)",
		min: 0,
		max: 300,
		default: 170,
	}),
	growTime: numberField({
		label: "Grow time (s)",
		min: 0,
		max: 3,
		step: 0.05,
		default: 0.6,
	}),
	reach: numberField({
		label: "Push reach (× radius)",
		min: 1,
		max: 7,
		step: 0.1,
		default: 4,
	}),
});

/**
 * A Cut: the stroke the user dragged, with the Tool settings it was made with.
 * Points are input-normalized; `t` is seconds since the Cut started, and
 * `releasedAt` is when the pointer was let go. Lengths (width, taper,
 * positionJitter) are relative to input width; spacing is a fraction of the
 * Cut's width.
 *
 * `now` is editor-only: it shows a live Cut as it looks at that moment, still
 * growing. Committed Cuts never have it and render settled, as at
 * releasedAt + AFTER_GROW_TIME.
 */
const cutSchema = z.object({
	points: z.array(
		z.object({ x: z.number(), y: z.number(), t: z.number().nonnegative() }),
	),
	releasedAt: z.number().nonnegative(),
	width: z.number().positive(),
	aspect: z.number().positive(),
	radiusJitter: z.number().nonnegative(),
	tiltJitter: z.number().nonnegative(),
	positionJitter: z.number().nonnegative(),
	spacing: z.number().positive(),
	taper: z.number().nonnegative(),
	growTime: z.number().nonnegative(),
	reach: z.number().min(1),
	now: z.number().optional(),
});

const stateSchema = z.object({
	cuts: z.array(cutSchema).default([]),
});

type Params = z.output<typeof paramsSchema>;
type State = z.output<typeof stateSchema>;
type Tools = z.output<typeof toolsSchema>;
type Cut = z.output<typeof cutSchema>;

// ---------------------------------------------------------------------------
// Laying out a Cut's ellipses

interface Ellipse {
	cx: number;
	cy: number;
	/** Angle of the across-stroke (long) axis, radians. */
	angle: number;
	/** Across-stroke radius, px. */
	a: number;
	/** Along-stroke radius, px. */
	b: number;
	/** Push fades out at this many radii. */
	reach: number;
}

const easeOut = (x: number) => 1 - (1 - x) ** 3;

/** The Cut's ellipses in pixels, in stroke order. */
function cutEllipses(cut: Cut, W: number, H: number, rng: Rng): Ellipse[] {
	const pts = cut.points.map((p) => ({ x: p.x * W, y: p.y * H, t: p.t }));
	if (pts.length < 2) return [];
	const arc = [0];
	for (let i = 1; i < pts.length; i++) {
		arc.push(
			arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y),
		);
	}
	const length = arc[arc.length - 1];
	if (length < MIN_CUT_LENGTH) return [];

	/** Position and time at arc length s. */
	const at = (s: number) => {
		s = Math.min(length, Math.max(0, s));
		let i = 1;
		while (i < arc.length - 1 && arc[i] < s) i++;
		const span = arc[i] - arc[i - 1];
		const f = span > 0 ? (s - arc[i - 1]) / span : 0;
		const p = pts[i - 1];
		const q = pts[i];
		return {
			x: p.x + (q.x - p.x) * f,
			y: p.y + (q.y - p.y) * f,
			t: p.t + (q.t - p.t) * f,
		};
	};

	const width = cut.width * W;
	const spacing = Math.max(1, cut.spacing * width);
	const taper = cut.taper * W;
	const jitterPx = cut.positionJitter * W;
	// Half-window for the tangent, so a wobbly hand still gives a steady direction.
	const h = Math.max(spacing, width * 0.25);
	const end = cut.now ?? cut.releasedAt + AFTER_GROW_TIME;
	const settle = easeOut(
		Math.min(1, Math.max(0, (end - cut.releasedAt) / AFTER_GROW_TIME)),
	);
	const afterGrow = 1 + AFTER_GROW_AMOUNT * settle;

	const out: Ellipse[] = [];
	for (let s = 0; s <= length; s += spacing) {
		// Always draw the same numbers per ellipse, so one ellipse's size can't shift another's jitter.
		const ja = rng.range(-1, 1);
		const jb = rng.range(-1, 1);
		const jt = rng.range(-1, 1);
		const jr = Math.sqrt(rng.next());
		const jphi = rng.range(0, 2 * Math.PI);

		const p = at(s);
		const growth =
			(cut.growTime > 0
				? easeOut(Math.min(1, Math.max(0, (end - p.t) / cut.growTime)))
				: 1) * afterGrow;
		// Both ends taper, so the Cut opens into a lens like slit lycra.
		const tapered =
			taper > 0
				? easeOut(Math.min(1, s / taper)) *
					easeOut(Math.min(1, (length - s) / taper))
				: 1;
		const scale = growth * tapered;
		const a =
			(width / 2) * scale * Math.max(0.05, 1 + (ja * cut.radiusJitter) / 100);
		if (a < MIN_RADIUS) continue;
		const b =
			(width / 2) *
			cut.aspect *
			scale *
			Math.max(0.05, 1 + (jb * cut.radiusJitter) / 100);

		const p0 = at(s - h);
		const p1 = at(s + h);
		const tangent = Math.atan2(p1.y - p0.y, p1.x - p0.x);
		out.push({
			cx: p.x + Math.cos(jphi) * jr * jitterPx,
			cy: p.y + Math.sin(jphi) * jr * jitterPx,
			angle: tangent + Math.PI / 2 + (jt * cut.tiltJitter * Math.PI) / 180,
			a,
			b: Math.max(MIN_RADIUS, b),
			reach: cut.reach,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Warping: each ellipse opens like a hole in incompressible rubber

/** Premultiplied RGBA as floats, one entry per channel. */
type Buffer = Float32Array;

/** Bilinear sample at (x, y) in pixel-center coordinates; transparent outside. */
function sample(
	buf: Buffer,
	W: number,
	H: number,
	x: number,
	y: number,
	out: Float32Array,
) {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	out.fill(0);
	for (let j = 0; j < 2; j++) {
		const yy = y0 + j;
		if (yy < 0 || yy >= H) continue;
		const wy = j ? fy : 1 - fy;
		for (let i = 0; i < 2; i++) {
			const xx = x0 + i;
			if (xx < 0 || xx >= W) continue;
			const w = wy * (i ? fx : 1 - fx);
			const k = (yy * W + xx) * 4;
			out[0] += buf[k] * w;
			out[1] += buf[k + 1] * w;
			out[2] += buf[k + 2] * w;
			out[3] += buf[k + 3] * w;
		}
	}
}

const smoothstep = (e0: number, e1: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
	return t * t * (3 - 2 * t);
};

/**
 * Open one ellipse in `buf`, in place. In the ellipse's normalized frame (where
 * it's the unit circle), a point at distance ρ came from √(ρ² − 1): the ring
 * of material keeps its area as the hole opens, so the ink inside is pushed
 * out around it. The push is scaled by `strength` and fades to nothing at
 * `reach`, which keeps the map monotonic (no folds). Marks every pixel it
 * moves in `pushed`.
 */
function openEllipse(
	buf: Buffer,
	pushed: Uint8Array,
	W: number,
	H: number,
	e: Ellipse,
	strength: number,
) {
	const cos = Math.cos(e.angle);
	const sin = Math.sin(e.angle);
	const A = e.a * e.reach;
	const B = e.b * e.reach;
	const ex = Math.sqrt(A * A * cos * cos + B * B * sin * sin);
	const ey = Math.sqrt(A * A * sin * sin + B * B * cos * cos);
	const x0 = Math.max(0, Math.floor(e.cx - ex));
	const x1 = Math.min(W - 1, Math.ceil(e.cx + ex));
	const y0 = Math.max(0, Math.floor(e.cy - ey));
	const y1 = Math.min(H - 1, Math.ceil(e.cy + ey));
	if (x0 > x1 || y0 > y1) return;

	const bw = x1 - x0 + 1;
	const tmp = new Float32Array(bw * (y1 - y0 + 1) * 4);
	const px = new Float32Array(4);
	const R = e.reach;

	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const t = ((y - y0) * bw + (x - x0)) * 4;
			const dx = x + 0.5 - e.cx;
			const dy = y + 0.5 - e.cy;
			const u = dx * cos + dy * sin;
			const v = -dx * sin + dy * cos;
			const qx = u / e.a;
			const qy = v / e.b;
			const rho = Math.hypot(qx, qy);
			const k = (y * W + x) * 4;
			if (rho >= R) {
				tmp[t] = buf[k];
				tmp[t + 1] = buf[k + 1];
				tmp[t + 2] = buf[k + 2];
				tmp[t + 3] = buf[k + 3];
				continue;
			}
			pushed[y * W + x] = 1;
			if (rho < 1e-6) continue; // Center of the hole: transparent.
			// Signed distance to the hole's edge in pixels (first order), for anti-aliasing.
			const grad = Math.hypot(qx / e.a, qy / e.b) / rho;
			const cov = Math.min(1, Math.max(0, (rho - 1) / grad + 0.5));
			if (cov === 0) continue;
			const r = Math.max(1, rho);
			const push = r - Math.sqrt(r * r - 1);
			const rhoIn = r - strength * (1 - smoothstep(1, R, r)) * push;
			const f = rhoIn / rho;
			const su = u * f;
			const sv = v * f;
			sample(
				buf,
				W,
				H,
				e.cx + su * cos - sv * sin - 0.5,
				e.cy + su * sin + sv * cos - 0.5,
				px,
			);
			tmp[t] = px[0] * cov;
			tmp[t + 1] = px[1] * cov;
			tmp[t + 2] = px[2] * cov;
			tmp[t + 3] = px[3] * cov;
		}
	}

	for (let y = y0; y <= y1; y++) {
		const row = (y - y0) * bw * 4;
		buf.set(tmp.subarray(row, row + bw * 4), (y * W + x0) * 4);
	}
}

/** Cuts the letters open along each Cut, in the order they were made. */
async function render({
	input,
	params,
	state,
	rng,
}: RenderContext<Params, State>) {
	const { width: W, height: H, data } = input;
	const buf: Buffer = new Float32Array(W * H * 4);
	for (let i = 0; i < W * H; i++) {
		const a = data[i * 4 + 3] / 255;
		buf[i * 4] = (data[i * 4] / 255) * a;
		buf[i * 4 + 1] = (data[i * 4 + 1] / 255) * a;
		buf[i * 4 + 2] = (data[i * 4 + 2] / 255) * a;
		buf[i * 4 + 3] = a;
	}

	const pushed = new Uint8Array(W * H);
	const px = new Float32Array(4);
	state.cuts.forEach((cut, index) => {
		const ellipses = cutEllipses(cut, W, H, rng.fork(`cut ${index}`));
		// Test for ink against the image as it was when this Cut began: its own
		// ellipses overlap, so testing as it goes would land each center in the
		// previous hole. Ink pushed out by earlier Cuts can still be torn.
		const onInk = ellipses.map((e) => {
			sample(buf, W, H, e.cx - 0.5, e.cy - 0.5, px);
			return px[3] >= INK_ALPHA;
		});
		ellipses.forEach((e, i) => {
			if (onInk[i]) openEllipse(buf, pushed, W, H, e, params.pushStrength);
		});
	});

	const out = createRaster(W, H);
	const o = out.data;
	for (let i = 0; i < W * H; i++) {
		const a = buf[i * 4 + 3];
		if (a <= 0 || (pushed[i] && a < PUSHED_MIN_ALPHA)) continue;
		o[i * 4] = Math.round((buf[i * 4] / a) * 255);
		o[i * 4 + 1] = Math.round((buf[i * 4 + 1] / a) * 255);
		o[i * 4 + 2] = Math.round((buf[i * 4 + 2] / a) * 255);
		o[i * 4 + 3] = Math.round(a * 255);
	}
	// No native SVG: export traces the raster, only when asked.
	return { raster: out };
}

// ---------------------------------------------------------------------------
// Editor

interface Gesture {
	/** Recorded points in image pixels; `t` in seconds since `start`. */
	points: { x: number; y: number; t: number }[];
	/** performance.now() when the Cut started. */
	start: number;
	/** Seconds since start when released, or null while held. */
	releasedAt: number | null;
	tools: Tools;
}

function TearEditor({
	input,
	params,
	state,
	setState,
	tools,
	seed,
	assets,
}: EditorProps<Params, State, Tools>) {
	const gesture = useRef<Gesture | null>(null);
	const [live, setLive] = useState<Cut | null>(null);
	const [animating, setAnimating] = useState(false);
	const [hover, setHover] = useState<{ p: ImagePoint; angle: number } | null>(
		null,
	);

	const shownState = useMemo(
		() => (live ? { ...state, cuts: [...state.cuts, live] } : state),
		[state, live],
	);
	const result = useRender(render, input, params, shownState, seed, assets);

	const W = input.width;
	const H = input.height;

	/** The gesture as a Cut; pass `now` to show it mid-growth (editor only). */
	const toCut = (g: Gesture, releasedAt: number, now?: number): Cut => ({
		points: g.points.map((p) => ({ x: p.x / W, y: p.y / H, t: p.t })),
		releasedAt,
		...(now === undefined ? {} : { now }),
		width: g.tools.width / W,
		aspect: g.tools.aspect,
		radiusJitter: g.tools.radiusJitter,
		tiltJitter: g.tools.tiltJitter,
		positionJitter: g.tools.positionJitter / W,
		spacing: g.tools.spacing / 100,
		taper: g.tools.taper / W,
		growTime: g.tools.growTime,
		reach: g.tools.reach,
	});

	const snapshot = (g: Gesture, now: number): Cut => {
		const elapsed = (now - g.start) / 1000;
		// While held, the Cut counts as released right now, with no after-growth yet.
		if (g.releasedAt === null) return toCut(g, elapsed, elapsed);
		return toCut(
			g,
			g.releasedAt,
			Math.min(elapsed, g.releasedAt + AFTER_GROW_TIME),
		);
	};

	const cutLength = (g: Gesture) => {
		let len = 0;
		for (let i = 1; i < g.points.length; i++) {
			len += Math.hypot(
				g.points[i].x - g.points[i - 1].x,
				g.points[i].y - g.points[i - 1].y,
			);
		}
		return len;
	};

	/** Commit the current gesture at its final size, if it's long enough to tear. */
	const commit = () => {
		const g = gesture.current;
		if (!g) return;
		gesture.current = null;
		if (cutLength(g) >= MIN_CUT_LENGTH) {
			const cut = toCut(
				g,
				g.releasedAt ?? (performance.now() - g.start) / 1000,
			);
			setState((s) => ({ ...s, cuts: [...s.cuts, cut] }));
		}
		setLive(null);
		setAnimating(false);
	};
	const commitRef = useRef(commit);
	commitRef.current = commit;
	// Don't lose a Cut that's still growing when the editor goes away.
	useEffect(() => () => commitRef.current(), []);

	// Advance the live Cut each time the previous render lands; updating faster
	// would make useRender drop every result as stale. After release it keeps
	// growing for AFTER_GROW_TIME, then commits.
	useEffect(() => {
		if (!animating || result.pending) return;
		const id = requestAnimationFrame(() => {
			const g = gesture.current;
			if (!g) return;
			const now = performance.now();
			if (
				g.releasedAt !== null &&
				(now - g.start) / 1000 >= g.releasedAt + AFTER_GROW_TIME
			)
				commit();
			else setLive(snapshot(g, now));
		});
		return () => cancelAnimationFrame(id);
	}, [animating, result]);

	const onDown = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		commit(); // A previous Cut still growing after release ends now.
		const now = performance.now();
		gesture.current = {
			points: [{ ...p, t: 0 }],
			start: now,
			releasedAt: null,
			tools,
		};
		setLive(snapshot(gesture.current, now));
		setAnimating(true);
	};

	const onMove = (p: ImagePoint) => {
		setHover((h) => {
			if (!h) return { p, angle: 0 };
			const d = Math.hypot(p.x - h.p.x, p.y - h.p.y);
			return {
				p,
				angle: d > 1 ? Math.atan2(p.y - h.p.y, p.x - h.p.x) : h.angle,
			};
		});
		const g = gesture.current;
		if (!g || g.releasedAt !== null) return;
		const last = g.points[g.points.length - 1];
		if (Math.hypot(p.x - last.x, p.y - last.y) < POINT_SPACING) return;
		g.points.push({ ...p, t: (performance.now() - g.start) / 1000 });
	};

	const onUp = () => {
		const g = gesture.current;
		if (!g || g.releasedAt !== null) return;
		g.releasedAt = (performance.now() - g.start) / 1000;
		if (cutLength(g) < MIN_CUT_LENGTH) commit();
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
					hover &&
					!gesture.current && (
						<ellipse
							cx={hover.p.x}
							cy={hover.p.y}
							rx={tools.width / 2}
							ry={(tools.width / 2) * tools.aspect}
							transform={`rotate(${((hover.angle + Math.PI / 2) * 180) / Math.PI} ${hover.p.x} ${hover.p.y})`}
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

export const tear = defineManipulation({
	id: "tear",
	version: 1,
	label: "Tear",
	paramsSchema,
	stateSchema,
	toolsSchema,
	render,
	Component: TearEditor,
});
