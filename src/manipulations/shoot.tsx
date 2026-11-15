import { useEffect, useRef, useState, type PointerEvent } from "react";
import { z } from "zod";
import { enumField, numberField } from "../core/fields";
import {
	defineManipulation,
	type EditorProps,
	type RenderContext,
} from "../core/manipulation";
import { cloneRaster } from "../core/raster";
import { remapItems } from "../core/remap";
import { createRng, randomSeed, type Rng } from "../core/rng";
import { useRender } from "../core/useRender";
import { OutputStatus } from "../ui/OutputStatus";
import { useAppElement } from "../store/appElement";
import { shake } from "../ui/shake";
import {
	imageToScreen,
	isOnCanvas,
	RasterView,
	type ImagePoint,
} from "../ui/RasterView";
import { breakInterface, imageGroup, inkPath } from "../ui/interfaceBreak";
import { sendWorker } from "../ui/worker";
import { ScreenOverlay } from "../ui/ScreenOverlay";

const paramsSchema = z.object({
	crackSize: numberField({
		label: "Crack length",
		min: 0,
		max: 4,
		step: 0.05,
		default: 2,
		hint: "Times the radius of an 80px hole; smaller holes crack relatively more",
	}),
});

/**
 * Shots in input pixels. `id` seeds the shot's cracks (and a spray's
 * pellets). A spray is one entry; its pellets are derived in render.
 */
const stateSchema = z.object({
	holes: z
		.array(
			z.object({
				x: z.number(),
				y: z.number(),
				r: z.number().positive(),
				id: z.number().int().optional(),
				kind: z.enum(["single", "spray"]).optional(),
			}),
		)
		.default([]),
});

const toolsSchema = z.object({
	shotType: enumField(["single", "spray"], {
		label: "Shot type",
		default: "single",
	}),
	size: numberField({ label: "Hole size (px)", min: 2, max: 100, default: 15 }),
	fireRate: numberField({
		label: "Fire rate (shots/s)",
		min: 1,
		max: 20,
		step: 0.5,
		default: 6,
		hint: "Hold to keep shooting. Spray fires slower",
	}),
});

/** When, into the shake, the hole appears. */
const HOLE_AT_MS = 80;
/** Hole size (px) up to which the shake stays at its minimum. */
const SHAKE_BASE_SIZE = 80;

/** A spray's pellets land within this many hole radii of the aim. */
const SPRAY_SPREAD = 5;
/** Spray fires at this fraction of the fire rate. */
const SPRAY_RATE = 0.3;
/** Spray shakes this many times harder. */
const SPRAY_SHAKE = 3;

type Params = z.output<typeof paramsSchema>;
type State = z.output<typeof stateSchema>;
type Tools = z.output<typeof toolsSchema>;

/** A point along a crack, with the crack's half-width there. */
interface CrackPoint {
	x: number;
	y: number;
	w: number;
}

/** Segments per crack. Fixed, so a crack keeps its shape when resized. */
const CRACK_SEGMENTS = 8;

/**
 * Grow one jagged, tapering crack (and maybe branches) from (x, y) toward
 * `angle`. Lengths and widths are in units of the crack size, so the shape
 * only depends on the rng, never on the size.
 */
function growCrack(
	rng: Rng,
	x: number,
	y: number,
	angle: number,
	length: number,
	width: number,
	depth: number,
	out: CrackPoint[][],
) {
	const step = length / CRACK_SEGMENTS;
	const line: CrackPoint[] = [{ x, y, w: width }];
	let dir = angle;
	for (let i = 1; i <= CRACK_SEGMENTS; i++) {
		// Zig-zag, pulled back toward the outward direction.
		dir += rng.gaussian(0, 0.35);
		dir += (angle - dir) * 0.3;
		x += Math.cos(dir) * step;
		y += Math.sin(dir) * step;
		// Wide at the base, narrowing quickly toward the tip.
		const w = width * (1 - i / CRACK_SEGMENTS) ** 1.6;
		line.push({ x, y, w });
		// Always draw, so branching doesn't shift the draws that follow.
		const branchDraw = rng.next();
		const side = rng.next() < 0.5 ? -1 : 1;
		const turn = rng.range(0.35, 0.8);
		const share = rng.range(0.3, 0.6);
		if (depth < 2 && i < CRACK_SEGMENTS - 1 && branchDraw < 0.15) {
			const rest = length * (1 - i / CRACK_SEGMENTS);
			growCrack(
				rng.fork(`branch-${i}`),
				x,
				y,
				dir + side * turn,
				rest * share,
				w * 0.7,
				depth + 1,
				out,
			);
		}
	}
	out.push(line);
}

/**
 * A hole's cracks: 3–6 of them spread around its edge, in units where the
 * hole is at the origin with radius 1 and the crack size is 1.
 */
function crackShapes(rng: Rng): { angle: number; lines: CrackPoint[][] }[] {
	const n = rng.int(3, 6);
	const base = rng.range(0, 2 * Math.PI);
	const shapes = [];
	for (let i = 0; i < n; i++) {
		const angle = base + ((i + rng.range(-0.35, 0.35)) * 2 * Math.PI) / n;
		const lines: CrackPoint[][] = [];
		growCrack(
			rng.fork(`crack-${i}`),
			0,
			0,
			angle,
			rng.range(0.5, 1.2),
			1,
			0,
			lines,
		);
		shapes.push({ angle, lines });
	}
	return shapes;
}

/** Hole radius at which crack length is exactly crackSize × radius. */
const CRACK_REF_RADIUS = 40;
/** How crack length grows with hole radius: 1 = linear, lower = small holes crack relatively more. */
const CRACK_GROWTH = 0.35;

/** Crack length per unit of crackSize, for a hole of radius r. Sub-linear in r. */
function crackScale(r: number) {
	return CRACK_REF_RADIUS * (r / CRACK_REF_RADIUS) ** CRACK_GROWTH;
}

/** Anti-aliased coverage mask: 1 where ink is cut away. */
class CutMask {
	readonly cover: Float32Array;
	constructor(
		readonly w: number,
		readonly h: number,
	) {
		this.cover = new Float32Array(w * h);
	}

	circle(cx: number, cy: number, r: number) {
		this.forBox(
			cx - r,
			cy - r,
			cx + r,
			cy + r,
			(px, py) => r - Math.hypot(px - cx, py - cy),
		);
	}

	/** A segment whose half-width goes from wa at a to wb at b. */
	taperedSegment(a: CrackPoint, b: CrackPoint) {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len2 = dx * dx + dy * dy || 1;
		const pad = Math.max(a.w, b.w);
		this.forBox(
			Math.min(a.x, b.x) - pad,
			Math.min(a.y, b.y) - pad,
			Math.max(a.x, b.x) + pad,
			Math.max(a.y, b.y) + pad,
			(px, py) => {
				const t = Math.min(
					1,
					Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / len2),
				);
				const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
				return a.w + (b.w - a.w) * t - d;
			},
		);
	}

	/** `inside` gives how far a pixel center is inside the shape, in px. */
	private forBox(
		x0: number,
		y0: number,
		x1: number,
		y1: number,
		inside: (px: number, py: number) => number,
	) {
		const { w, h, cover } = this;
		const ix0 = Math.max(0, Math.floor(x0 - 1));
		const ix1 = Math.min(w - 1, Math.ceil(x1 + 1));
		const iy0 = Math.max(0, Math.floor(y0 - 1));
		const iy1 = Math.min(h - 1, Math.ceil(y1 + 1));
		for (let y = iy0; y <= iy1; y++) {
			for (let x = ix0; x <= ix1; x++) {
				const c = Math.min(1, Math.max(0, inside(x + 0.5, y + 0.5) + 0.5));
				const i = y * w + x;
				if (c > cover[i]) cover[i] = c;
			}
		}
	}
}

/** One hole a shot cuts away, in image px, with its cracks as tapered segments. */
interface HoleMarks {
	x: number;
	y: number;
	r: number;
	segments: [CrackPoint, CrackPoint][];
}

/** The holes, with their cracks, a shot (a single hole, or a spray of pellets) makes. */
function shotMarks(
	hole: { x: number; y: number; r: number; kind?: "single" | "spray" },
	crackSize: number,
	shotRng: Rng,
): HoleMarks[] {
	const marks: HoleMarks[] = [];
	// One hole with its cracks.
	const punch = (cx: number, cy: number, r: number, holeRng: Rng) => {
		const segments: HoleMarks["segments"] = [];
		marks.push({ x: cx, y: cy, r, segments });
		if (crackSize <= 0) return;
		const size = crackSize * crackScale(r);
		const width = Math.min(12, Math.max(1.5, r * 0.12));
		for (const { angle, lines } of crackShapes(holeRng)) {
			// Start a little inside the edge so the crack joins the hole cleanly.
			const sx = cx + Math.cos(angle) * (r - width);
			const sy = cy + Math.sin(angle) * (r - width);
			for (const line of lines) {
				const pts = line.map((p) => ({
					x: sx + p.x * size,
					y: sy + p.y * size,
					w: p.w * width,
				}));
				for (let j = 1; j < pts.length; j++)
					segments.push([pts[j - 1], pts[j]]);
			}
		}
	};
	if (hole.kind !== "spray") {
		punch(hole.x, hole.y, hole.r, shotRng);
		return marks;
	}
	// Pellets: clustered toward the aim, none past the spread.
	const n = shotRng.int(6, 10);
	for (let j = 0; j < n; j++) {
		const a = shotRng.range(0, 2 * Math.PI);
		const d =
			hole.r * SPRAY_SPREAD * Math.min(1, Math.abs(shotRng.gaussian(0, 0.5)));
		const pr = hole.r * shotRng.range(0.6, 1);
		punch(
			hole.x + Math.cos(a) * d,
			hole.y + Math.sin(a) * d,
			pr,
			shotRng.fork(`pellet-${j}`),
		);
	}
	return marks;
}

/** Punch anti-aliased circular holes, with cracks, through the ink. */
async function render({
	input,
	params,
	state,
	rng,
}: RenderContext<Params, State>) {
	const out = cloneRaster(input);
	const { width: w, height: h, data } = out;
	const mask = new CutMask(w, h);
	state.holes.forEach((hole, i) => {
		const marks = shotMarks(hole, params.crackSize, rng.fork(`hole-${hole.id ?? i}`));
		for (const m of marks) {
			mask.circle(m.x, m.y, m.r);
			for (const [a, b] of m.segments) mask.taperedSegment(a, b);
		}
	});
	for (let i = 0; i < mask.cover.length; i++) {
		if (mask.cover[i] > 0) data[i * 4 + 3] *= 1 - mask.cover[i];
	}
	return { raster: out };
}

/** A hole's marks as an SVG path: its circle, and segments as tapered capsules. */
function marksPath({ x, y, r, segments }: HoleMarks): string {
	const circle = (x: number, y: number, r: number) =>
		r > 0
			? `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`
			: "";
	const parts = [circle(x, y, r)];
	for (const [a, b] of segments) {
		const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const nx = -(b.y - a.y) / len;
		const ny = (b.x - a.x) / len;
		parts.push(
			`M${a.x + nx * a.w} ${a.y + ny * a.w}L${b.x + nx * b.w} ${b.y + ny * b.w}` +
				`L${b.x - nx * b.w} ${b.y - ny * b.w}L${a.x - nx * a.w} ${a.y - ny * a.w}Z`,
			circle(a.x, a.y, a.w),
			circle(b.x, b.y, b.w),
		);
	}
	return parts.join("");
}

/** How long a hole in the interface waits before its Worker sets out, in ms. */
const WORKER_DELAY_MS = 400;
/** How long a Worker works on a hole, in ms, plus per screen px of its radius. */
const WORK_MS = 1600;
const WORK_PER_PX = 25;

/**
 * A shot that missed the Canvas: the same marks, over the interface. Each
 * hole (each pellet of a spray) is its own break, and a Worker comes to fix
 * it: when it's done, the hole is gone.
 */
function shootInterface(
	hole: { x: number; y: number; r: number; kind: "single" | "spray" },
	crackSize: number,
	toScreen: DOMMatrixReadOnly,
) {
	const zoom = toScreen.a;
	for (const m of shotMarks(hole, crackSize, createRng(randomSeed()))) {
		const at = toScreen.transformPoint(new DOMPoint(m.x, m.y));
		const radius = m.r * zoom;
		breakInterface({
			holdMs: WORKER_DELAY_MS,
			draw: (container) =>
				imageGroup(container, toScreen).append(inkPath(marksPath(m))),
			repair: (container) =>
				sendWorker(container, {
					x: at.x,
					y: at.y,
					radius,
					workMs: WORK_MS + radius * WORK_PER_PX,
				}),
		});
	}
}

/** Aiming reticle: the hole's ring, with ticks crossing it and a center dot. */
function Crosshair({ x, y, r }: { x: number; y: number; r: number }) {
	const inner = r * 0.45;
	const outer = r * 1.35;
	const ticks = [
		[0, -1],
		[0, 1],
		[-1, 0],
		[1, 0],
	];
	return (
		<g
			stroke="#e5484d"
			strokeWidth={1.5}
			fill="none"
			vectorEffect="non-scaling-stroke"
			pointerEvents="none"
		>
			<circle cx={x} cy={y} r={r} vectorEffect="non-scaling-stroke" />
			{ticks.map(([dx, dy]) => (
				<line
					key={`${dx},${dy}`}
					x1={x + dx * inner}
					y1={y + dy * inner}
					x2={x + dx * outer}
					y2={y + dy * outer}
					vectorEffect="non-scaling-stroke"
				/>
			))}
			<circle
				cx={x}
				cy={y}
				r={Math.max(1, r * 0.04)}
				fill="#e5484d"
				stroke="none"
			/>
		</g>
	);
}

/** Where a shot goes: an image point, and whether it's on the Canvas. */
interface Aim {
	p: ImagePoint;
	onCanvas: boolean;
	/** Image px → viewport px, for drawing off the Canvas. */
	toScreen: DOMMatrixReadOnly;
}

function ShootEditor({
	input,
	params,
	state,
	setState,
	tools,
	seed,
	assets,
}: EditorProps<Params, State, Tools>) {
	const result = useRender(render, input, params, state, seed, assets);
	const [hover, setHover] = useState<Aim | null>(null);
	const timers = useRef<number[]>([]);
	// While held: where to aim next, and the repeating trigger.
	const aim = useRef<Aim | null>(null);
	const autoFire = useRef<number | null>(null);
	const stopFiring = () => {
		if (autoFire.current !== null) clearInterval(autoFire.current);
		autoFire.current = null;
		aim.current = null;
	};
	useEffect(
		() => () => {
			timers.current.forEach(clearTimeout);
			stopFiring();
		},
		[],
	);
	// Aiming at the interface: the crosshair stands in for the cursor.
	const aimingOut = hover !== null && !hover.onCanvas;
	useEffect(() => {
		if (!aimingOut) return;
		document.documentElement.classList.add("hide-cursor");
		return () => document.documentElement.classList.remove("hide-cursor");
	}, [aimingOut]);

	const spray = tools.shotType === "spray";

	// A shot: the camera shakes, then the hole (or a spray's pellets) appears,
	// in the image, or over the interface if it missed the Canvas.
	const shoot = ({ p, onCanvas, toScreen }: Aim) => {
		const r = tools.size / 2;
		const kind = tools.shotType;
		// Bigger holes, bigger shake; never less than the default size's.
		shake(
			useAppElement.getState().appElement,
			Math.max(1, tools.size / SHAKE_BASE_SIZE) *
				(kind === "spray" ? SPRAY_SHAKE : 1),
		);
		const t = window.setTimeout(() => {
			timers.current = timers.current.filter((x) => x !== t);
			if (!onCanvas) {
				shootInterface({ x: p.x, y: p.y, r, kind }, params.crackSize, toScreen);
				return;
			}
			setState((s) => ({
				...s,
				holes: [...s.holes, { x: p.x, y: p.y, r, id: randomSeed(), kind }],
			}));
		}, HOLE_AT_MS);
		timers.current.push(t);
	};

	// Press to shoot; hold to keep shooting at the cursor, even off the
	// Canvas. Each shot in the image is saved as its own hole, same as a
	// single press.
	const startFiring = (a: Aim) => {
		stopFiring();
		aim.current = a;
		shoot(a);
		autoFire.current = window.setInterval(
			() => aim.current && shoot(aim.current),
			1000 / (tools.fireRate * (spray ? SPRAY_RATE : 1)),
		);
	};

	const aimAt = (p: ImagePoint, e: PointerEvent<SVGSVGElement>): Aim => ({
		p,
		onCanvas: isOnCanvas(e),
		toScreen: imageToScreen(e.currentTarget),
	});

	const crosshair = hover && (
		<Crosshair
			x={hover.p.x}
			y={hover.p.y}
			// A spray aims with its spread.
			r={(tools.size / 2) * (spray ? SPRAY_SPREAD : 1)}
		/>
	);

	return (
		<>
			<RasterView
				// Output is the same size as input, so image coords map 1:1.
				image={result.output?.raster ?? input}
				cursor="none"
				onPointerMove={(p, e) => {
					const a = aimAt(p, e);
					setHover(a);
					if (aim.current) aim.current = a;
				}}
				onPointerLeave={() => {
					setHover(null);
					stopFiring();
				}}
				onPointerDown={(p, e) => {
					// Keep getting the pointer off the Canvas, to shoot the interface.
					e.currentTarget.setPointerCapture(e.pointerId);
					startFiring(aimAt(p, e));
				}}
				onPointerUp={(_, e) => {
					stopFiring();
					if (!isOnCanvas(e)) setHover(null);
				}}
				overlay={hover?.onCanvas && crosshair}
			/>
			{hover && !hover.onCanvas && (
				<ScreenOverlay toScreen={hover.toScreen}>{crosshair}</ScreenOverlay>
			)}
			<OutputStatus result={result} />
		</>
	);
}

export const shoot = defineManipulation({
	id: "shoot",
	version: 1,
	label: "Shoot",
	paramsSchema,
	stateSchema,
	toolsSchema,
	render,
	// A hole goes with its letter, and away with it.
	remapState: (state, remap) => ({
		...state,
		holes: remapItems(state.holes, remap, {
			samples: (h) => [h],
			dropAbove: 0.5,
			move: (h, [{ to }]) => ({ ...h, x: to.x, y: to.y, r: h.r * remap.scale }),
		}),
	}),
	Component: ShootEditor,
});
