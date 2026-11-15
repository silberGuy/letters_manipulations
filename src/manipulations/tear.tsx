import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { z } from "zod";
import { numberField } from "../core/fields";
import {
	defineManipulation,
	type EditorProps,
	type RenderContext,
	type RenderQuality,
} from "../core/manipulation";
import { PushCanvas, type Ellipse } from "../core/push";
import { remapItems, type Remap } from "../core/remap";
import { createRng, randomSeed, type Rng } from "../core/rng";
import { useRender } from "../core/useRender";
import { OutputStatus } from "../ui/OutputStatus";
import {
	cropPixels,
	snapshotInterface,
	type InterfaceSnapshot,
} from "../ui/snapshot";
import {
	snapshotBox,
	snapshotBreak,
	toSnapshot,
	type SnapshotBreak,
} from "../ui/snapshotBreak";
import {
	imageToScreen,
	isOnCanvas,
	RasterView,
	type ImagePoint,
} from "../ui/RasterView";

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
 * Points and lengths (width, taper, positionJitter) are in input pixels; `t` is
 * seconds since the Cut started, and `releasedAt` is when the pointer was let
 * go. Spacing is a fraction of the Cut's width. `id` picks the Cut's random
 * stream, so removing one Cut doesn't change the others.
 *
 * `now` is editor-only: it shows a live Cut as it looks at that moment, still
 * growing. Committed Cuts never have it and render settled, as at
 * releasedAt + AFTER_GROW_TIME.
 */
const cutSchema = z.object({
	id: z.number().int().optional(),
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

const easeOut = (x: number) => 1 - (1 - x) ** 3;

/**
 * The Cut's ellipses in pixels, in stroke order. `a` is the across-stroke
 * radius, `b` the along-stroke one.
 */
function cutEllipses(cut: Cut, rng: Rng): Ellipse[] {
	const pts = cut.points;
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

	const width = cut.width;
	const spacing = Math.max(1, cut.spacing * width);
	const taper = cut.taper;
	const jitterPx = cut.positionJitter;
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
// Render

/** Cuts the letters open along each Cut, in the order they were made. */
async function render({
	input,
	params,
	state,
	rng,
	quality,
}: RenderContext<Params, State>) {
	const canvas = new PushCanvas(input, quality);
	state.cuts.forEach((cut, index) => {
		const ellipses = cutEllipses(cut, rng.fork(`cut ${cut.id ?? index}`));
		// Test for ink against the image as it was when this Cut began: its own
		// ellipses overlap, so testing as it goes would land each center in the
		// previous hole. Ink pushed out by earlier Cuts can still be torn.
		const onInk = ellipses.map((e) => canvas.alphaAt(e.cx, e.cy) >= INK_ALPHA);
		ellipses.forEach((e, i) => {
			if (onInk[i]) canvas.open(e, params.pushStrength);
		});
	});
	// No native SVG: export traces the raster, only when asked.
	return { raster: canvas.toImageData(PUSHED_MIN_ALPHA) };
}

/**
 * A Cut follows the letter it started on (or, if that one's gone, the first
 * surviving letter along it) as one rigid piece, scaled with the font size.
 * Moving its points separately would stretch it, changing how it grows. A Cut
 * that was mostly on deleted letters goes with them.
 */
function remapState(state: State, remap: Remap): State {
	const k = remap.scale;
	return {
		...state,
		cuts: remapItems(state.cuts, remap, {
			samples: (cut) => cut.points,
			dropAbove: 0.5,
			move: (cut, located) => {
				const i = located.findIndex((l) => !l.deleted);
				if (i < 0) return cut;
				const from = cut.points[i];
				const to = located[i].to;
				return {
					...cut,
					points: cut.points.map((p) => ({
						x: to.x + (p.x - from.x) * k,
						y: to.y + (p.y - from.y) * k,
						t: p.t,
					})),
					width: cut.width * k,
					taper: cut.taper * k,
					positionJitter: cut.positionJitter * k,
				};
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// Interface Break

/** How long a tear in the interface waits, once it stops growing, before its Workers set out, in ms. */
const WORKER_DELAY_MS = 400;
/** How long the Workers work on a tear once they're all there, in ms. */
const WORK_MS = 1200;

/** Ellipses as one SVG path. */
function ellipsesPath(ellipses: Ellipse[]): string {
	return ellipses
		.map(({ cx, cy, angle, a, b }) => {
			const dx = Math.cos(angle) * a;
			const dy = Math.sin(angle) * a;
			const deg = (angle * 180) / Math.PI;
			return (
				`M${cx + dx} ${cy + dy}A${a} ${b} ${deg} 0 1 ${cx - dx} ${cy - dy}` +
				`A${a} ${b} ${deg} 0 1 ${cx + dx} ${cy + dy}Z`
			);
		})
		.join("");
}

/** The tear's ellipses now, and the quality to push them at. */
interface TearShape {
	ellipses: Ellipse[];
	quality: RenderQuality;
}

/**
 * A Cut that left the Canvas tears the interface too: its ellipses off the
 * Canvas (on it, only the ink tears) open in a snapshot of the interface with
 * the same push as in the image. The holes are dark, as if the interface were
 * a sheet over ink, so the push shoves its lines around solid shapes, as a
 * letter's edge is. It grows with the Cut until settled.
 */
function tearInterface(
	toScreen: DOMMatrixReadOnly,
	canvas: DOMRectReadOnly,
	snapshot: Promise<InterfaceSnapshot | null>,
	pushStrength: number,
): SnapshotBreak<TearShape> {
	const onCanvas = (p: { x: number; y: number }) =>
		p.x >= canvas.left &&
		p.x < canvas.right &&
		p.y >= canvas.top &&
		p.y < canvas.bottom;
	const toViewport = (e: Ellipse) => {
		const c = toScreen.transformPoint(new DOMPoint(e.cx, e.cy));
		return { x: c.x, y: c.y };
	};
	return snapshotBreak<TearShape>({
		snapshot,
		toScreen,
		canvas,
		holes: "ink",
		delayMs: WORKER_DELAY_MS,
		workMs: WORK_MS,
		plain: ({ ellipses }) => ellipsesPath(ellipses),
		crew: ({ ellipses }) => ellipses.map(toViewport),
		render: (snap, { ellipses, quality }) => {
			// The ellipses off the Canvas, in snapshot px.
			const k = toScreen.a * snap.scale;
			const es: Ellipse[] = ellipses
				.filter((e) => !onCanvas(toViewport(e)))
				.map((e) => {
					const c = toSnapshot(snap, toScreen, e.cx, e.cy);
					return { ...e, cx: c.x, cy: c.y, a: e.a * k, b: e.b * k };
				});
			const box = snapshotBox(
				snap,
				es.map((e) => ({ x: e.cx, y: e.cy, r: Math.max(e.a, e.b) * e.reach })),
			);
			if (!box) return null;
			const { x0, y0, w, h } = box;
			const push = new PushCanvas(cropPixels(snap.pixels, x0, y0, w, h), quality);
			for (const e of es)
				push.open({ ...e, cx: e.cx - x0, cy: e.cy - y0 }, pushStrength);
			return { pixels: push.toImageData(PUSHED_MIN_ALPHA), x: x0, y: y0 };
		},
	});
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
	/** The Cut's id, fixed for the gesture so the preview matches the committed Cut. */
	id: number;
	/** Image px → viewport px, and the Canvas on screen, from the press. */
	toScreen: DOMMatrixReadOnly;
	canvas: DOMRectReadOnly;
	/** The interface as it was at the press, for tearing it if the Cut leaves the Canvas. */
	snapshot: Promise<InterfaceSnapshot | null>;
	/** Once the Cut has left the Canvas: its tear in the interface. */
	interfaceTear: SnapshotBreak<TearShape> | null;
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

	/** The gesture as a Cut; pass `now` to show it mid-growth (editor only). */
	const toCut = (g: Gesture, releasedAt: number, now?: number): Cut => ({
		id: g.id,
		points: g.points.map((p) => ({ ...p })),
		releasedAt,
		...(now === undefined ? {} : { now }),
		width: g.tools.width,
		aspect: g.tools.aspect,
		radiusJitter: g.tools.radiusJitter,
		tiltJitter: g.tools.tiltJitter,
		positionJitter: g.tools.positionJitter,
		spacing: g.tools.spacing / 100,
		taper: g.tools.taper,
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

	/** A Cut's ellipses, the same as render lays them out. */
	const ellipsesOf = (cut: Cut) =>
		cutEllipses(cut, createRng(seed).fork(`cut ${cut.id}`));

	/** Commit the current gesture at its final size, if it's long enough to tear. */
	const commit = () => {
		const g = gesture.current;
		if (!g) return;
		gesture.current = null;
		const cut = toCut(g, g.releasedAt ?? (performance.now() - g.start) / 1000);
		if (cutLength(g) >= MIN_CUT_LENGTH)
			setState((s) => ({ ...s, cuts: [...s.cuts, cut] }));
		if (g.interfaceTear) {
			g.interfaceTear.update({ ellipses: ellipsesOf(cut), quality: "final" });
			g.interfaceTear.settle();
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
			else {
				const cut = snapshot(g, now);
				setLive(cut);
				g.interfaceTear?.update({ ellipses: ellipsesOf(cut), quality: "draft" });
			}
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
			id: randomSeed(),
			toScreen: imageToScreen(e.currentTarget),
			canvas: e.currentTarget.getBoundingClientRect(),
			snapshot: snapshotInterface(),
			interfaceTear: null,
		};
		setLive(snapshot(gesture.current, now));
		setAnimating(true);
	};

	const onMove = (p: ImagePoint, e: PointerEvent<SVGSVGElement>) => {
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
		if (!g.interfaceTear && !isOnCanvas(e))
			g.interfaceTear = tearInterface(
				g.toScreen,
				g.canvas,
				g.snapshot,
				params.pushStrength,
			);
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
	version: 2,
	label: "Tear",
	paramsSchema,
	stateSchema,
	toolsSchema,
	render,
	remapState,
	Component: TearEditor,
});
