import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { numberField } from '../core/fields';
import { defineManipulation, type EditorProps, type RenderContext } from '../core/manipulation';
import { cloneRaster } from '../core/raster';
import { remapItems } from '../core/remap';
import { randomSeed, type Rng } from '../core/rng';
import { useRender } from '../core/useRender';
import { OutputStatus } from '../ui/OutputStatus';
import { useAppElement } from '../store/appElement';
import { RasterView, type ImagePoint } from '../ui/RasterView';

const paramsSchema = z.object({
  crackSize: numberField({
    label: 'Crack length (× hole radius)',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.6,
  }),
});

/** Holes in input pixels. `id` seeds the hole's cracks. */
const stateSchema = z.object({
  holes: z
    .array(z.object({ x: z.number(), y: z.number(), r: z.number().positive(), id: z.number().int().optional() }))
    .default([]),
});

const toolsSchema = z.object({
  size: numberField({ label: 'Hole size (px)', min: 2, max: 600, default: 80 }),
});

/** How long the camera shakes. */
const SHAKE_MS = 160;
/** When, into the shake, the hole appears. */
const HOLE_AT_MS = 80;
/** Hole size (px) up to which the shake stays at its minimum. */
const SHAKE_BASE_SIZE = 80;

/** Shakes in progress; the page's overflow is hidden while any run. */
let activeShakes = 0;

/**
 * A short vertical "camera" shake of the whole interface. Hides the page's
 * overflow meanwhile so the moving app can't flash a scrollbar.
 */
function shake(el: HTMLElement | null, holeSize: number) {
  if (!el) return;
  activeShakes++;
  document.body.style.overflow = 'hidden';
  // Bigger holes, bigger shake; never less than the default size's.
  const k = Math.max(1, holeSize / SHAKE_BASE_SIZE);
  const animation = el.animate(
    [0, -7, 5, -3, 2, 0].map((y) => ({ translate: `0 ${y * k}px` })),
    { duration: SHAKE_MS, easing: 'ease-out' },
  );
  const done = () => {
    if (--activeShakes === 0) document.body.style.overflow = '';
  };
  animation.addEventListener('finish', done);
  animation.addEventListener('cancel', done);
}

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
    const w = width * (1 - i / CRACK_SEGMENTS);
    line.push({ x, y, w });
    // Always draw, so branching doesn't shift the draws that follow.
    const branchDraw = rng.next();
    const side = rng.next() < 0.5 ? -1 : 1;
    const turn = rng.range(0.35, 0.8);
    const share = rng.range(0.3, 0.6);
    if (depth < 2 && i < CRACK_SEGMENTS - 1 && branchDraw < 0.15) {
      const rest = length * (1 - i / CRACK_SEGMENTS);
      growCrack(rng.fork(`branch-${i}`), x, y, dir + side * turn, rest * share, w * 0.7, depth + 1, out);
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
    growCrack(rng.fork(`crack-${i}`), 0, 0, angle, rng.range(0.5, 1.2), 1, 0, lines);
    shapes.push({ angle, lines });
  }
  return shapes;
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
    this.forBox(cx - r, cy - r, cx + r, cy + r, (px, py) => r - Math.hypot(px - cx, py - cy));
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
        const t = Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / len2));
        const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
        return a.w + (b.w - a.w) * t - d;
      },
    );
  }

  /** `inside` gives how far a pixel center is inside the shape, in px. */
  private forBox(x0: number, y0: number, x1: number, y1: number, inside: (px: number, py: number) => number) {
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

/** Punch anti-aliased circular holes, with cracks, through the ink. */
async function render({ input, params, state, rng }: RenderContext<Params, State>) {
  const out = cloneRaster(input);
  const { width: w, height: h, data } = out;
  const mask = new CutMask(w, h);
  state.holes.forEach((hole, i) => {
    const { x: cx, y: cy, r } = hole;
    mask.circle(cx, cy, r);
    if (params.crackSize <= 0) return;
    const size = params.crackSize * r;
    const width = Math.min(6, Math.max(1, r * 0.06));
    for (const { angle, lines } of crackShapes(rng.fork(`hole-${hole.id ?? i}`))) {
      // Start a little inside the edge so the crack joins the hole cleanly.
      const sx = cx + Math.cos(angle) * (r - width);
      const sy = cy + Math.sin(angle) * (r - width);
      for (const line of lines) {
        const pts = line.map((p) => ({ x: sx + p.x * size, y: sy + p.y * size, w: p.w * width }));
        for (let j = 1; j < pts.length; j++) mask.taperedSegment(pts[j - 1], pts[j]);
      }
    }
  });
  for (let i = 0; i < mask.cover.length; i++) {
    if (mask.cover[i] > 0) data[i * 4 + 3] *= 1 - mask.cover[i];
  }
  return { raster: out };
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
    <g stroke="#e5484d" strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" pointerEvents="none">
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
      <circle cx={x} cy={y} r={Math.max(1, r * 0.04)} fill="#e5484d" stroke="none" />
    </g>
  );
}

function ShootEditor({ input, params, state, setState, tools, seed, assets }: EditorProps<Params, State, Tools>) {
  const result = useRender(render, input, params, state, seed, assets);
  const [hover, setHover] = useState<ImagePoint | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // A shot: the camera shakes, then the hole appears.
  const shoot = (p: ImagePoint) => {
    const r = tools.size / 2;
    shake(useAppElement.getState().appElement, tools.size);
    const t = window.setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== t);
      setState((s) => ({ ...s, holes: [...s.holes, { x: p.x, y: p.y, r, id: randomSeed() }] }));
    }, HOLE_AT_MS);
    timers.current.push(t);
  };

  return (
    <>
      <RasterView
        // Output is the same size as input, so image coords map 1:1.
        image={result.output?.raster ?? input}
        cursor="none"
        onPointerMove={setHover}
        onPointerLeave={() => setHover(null)}
        onPointerDown={shoot}
        overlay={hover && <Crosshair x={hover.x} y={hover.y} r={tools.size / 2} />}
      />
      <OutputStatus result={result} />
    </>
  );
}

export const shoot = defineManipulation({
  id: 'shoot',
  version: 1,
  label: 'Shoot',
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
