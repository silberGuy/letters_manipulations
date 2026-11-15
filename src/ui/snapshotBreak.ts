import { breakInterface, imageGroup, inkPath } from './interfaceBreak';
import { cropPixels, type InterfaceSnapshot } from './snapshot';
import { crewSpots, sendWorkers } from './worker';

/** Part of the interface as a break redraws it: pixels placed at (x, y), in snapshot px. */
export interface SnapshotPatch {
  pixels: ImageData;
  x: number;
  y: number;
  /**
   * Where the patch may show over the Canvas (1 per pixel; e.g. inside holes
   * that reach onto it from the interface). Without it, it leaves the Canvas
   * alone entirely.
   */
  onCanvas?: Uint8Array;
}

export interface SnapshotBreakOptions<T> {
  /** The interface as it was when the gesture began. */
  snapshot: Promise<InterfaceSnapshot | null>;
  /** Image px → viewport px of the Canvas the gesture is on. */
  toScreen: DOMMatrixReadOnly;
  /** The Canvas on screen: the break leaves it alone. */
  canvas: DOMRectReadOnly;
  /** What shows through the patch where it's transparent (its holes). */
  holes: 'paper' | 'ink';
  /** How long it waits, once settled, before its Workers set out, in ms. */
  delayMs: number;
  /** How long the Workers work once they're all there, in ms. */
  workMs: number;
  /** Redraw the interface for the gesture's current `value`, or null for nothing. */
  render(snap: InterfaceSnapshot, value: T): SnapshotPatch | null;
  /** Until the snapshot is ready: an SVG path (image px) to show instead, filled like the holes. */
  plain?(value: T): string;
  /** Where Workers go (viewport px), along the break; spots on the Canvas are skipped. */
  crew(value: T): { x: number; y: number }[];
}

export interface SnapshotBreak<T> {
  /** The gesture moved on: redraw for its new value. */
  update(value: T): void;
  /** The gesture is over: the break holds, then its Workers fix it. */
  settle(): void;
}

/**
 * An Interface Break that redraws part of the interface from a snapshot as a
 * gesture goes on (e.g. a Tear or acid continuing off the Canvas), laid over
 * the interface as a patch, then fixed by a crew of Workers.
 */
export function snapshotBreak<T>(o: SnapshotBreakOptions<T>): SnapshotBreak<T> {
  const { toScreen, canvas } = o;
  const fill = o.holes === 'ink' ? 'var(--ink)' : 'var(--paper)';
  const holeColor = cssColor(fill);
  // The Canvas in image px (no rotation, so a rect stays a rect).
  const toImage = toScreen.inverse();
  const p0 = toImage.transformPoint(new DOMPoint(canvas.left, canvas.top));
  const p1 = toImage.transformPoint(new DOMPoint(canvas.right, canvas.bottom));
  const path = inkPath('');
  path.style.fill = fill;
  const patch = document.createElement('canvas');
  patch.style.position = 'absolute';
  patch.style.display = 'none';

  let snap: InterfaceSnapshot | null = null;
  let last: { value: T } | null = null;
  let settle = () => {};
  const onCanvas = (p: { x: number; y: number }) =>
    p.x >= canvas.left && p.x < canvas.right && p.y >= canvas.top && p.y < canvas.bottom;

  breakInterface({
    holdMs: o.delayMs,
    formed: new Promise<void>((r) => (settle = r)),
    draw: (container) => {
      imageGroup(container, toScreen, {
        x: Math.min(p0.x, p1.x),
        y: Math.min(p0.y, p1.y),
        width: Math.abs(p1.x - p0.x),
        height: Math.abs(p1.y - p0.y),
      }).append(path);
      container.append(patch);
    },
    repair: (container) =>
      sendWorkers(container, last ? crewSpots(o.crew(last.value), (p) => !onCanvas(p)) : [], o.workMs),
  });

  const draw = (value: T) => {
    if (!snap) {
      path.setAttribute('d', o.plain?.(value) ?? '');
      return;
    }
    path.setAttribute('d', '');
    const out = o.render(snap, value);
    if (!out) {
      patch.style.display = 'none';
      return;
    }
    const { x, y } = out;
    const { scale } = snap;
    const pixels = onlyChanges(
      out.pixels,
      cropPixels(snap.pixels, x, y, out.pixels.width, out.pixels.height),
      holeColor,
    );
    // Over the Canvas, only where the break says it may show.
    if (out.onCanvas) {
      const { width: w, height: h, data } = pixels;
      for (let j = 0; j < h; j++) {
        const vy = snap.y + (y + j + 0.5) / scale;
        if (vy < canvas.top || vy >= canvas.bottom) continue;
        for (let i = 0; i < w; i++) {
          const vx = snap.x + (x + i + 0.5) / scale;
          if (vx < canvas.left || vx >= canvas.right) continue;
          if (!out.onCanvas[j * w + i]) data[(j * w + i) * 4 + 3] = 0;
        }
      }
    }
    patch.width = pixels.width;
    patch.height = pixels.height;
    patch.getContext('2d')!.putImageData(pixels, 0, 0);
    // Placed in viewport px; the Canvas is left alone.
    const left = snap.x + x / scale;
    const top = snap.y + y / scale;
    patch.style.display = 'block';
    patch.style.left = `${left}px`;
    patch.style.top = `${top}px`;
    patch.style.width = `${pixels.width / scale}px`;
    patch.style.height = `${pixels.height / scale}px`;
    const cl = canvas.left - left;
    const ct = canvas.top - top;
    patch.style.clipPath = out.onCanvas
      ? ''
      : `path(evenodd, "M-100000 -100000H100000V100000H-100000Z ` +
        `M${cl} ${ct}h${canvas.width}v${canvas.height}h${-canvas.width}Z")`;
  };

  void o.snapshot.then((s) => {
    snap = s;
    if (snap && last) draw(last.value);
  });

  return {
    update: (value) => {
      last = { value };
      draw(value);
    },
    settle: () => settle(),
  };
}

/** Channels may differ by this much and still count as unchanged. */
const UNCHANGED = 3;

/**
 * Only what a break changed, so the live interface shows through everywhere
 * else (a whole snapshot rect would show its edges wherever it's stale or a
 * little off): `pixels` laid over `hole` (so its holes take that color),
 * transparent wherever that matches `before`.
 */
function onlyChanges(
  pixels: ImageData,
  before: ImageData,
  hole: [number, number, number],
): ImageData {
  const out = new ImageData(pixels.width, pixels.height);
  const p = pixels.data;
  const b = before.data;
  const o = out.data;
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3] / 255;
    const r = p[i] * a + hole[0] * (1 - a);
    const g = p[i + 1] * a + hole[1] * (1 - a);
    const bl = p[i + 2] * a + hole[2] * (1 - a);
    if (
      Math.abs(r - b[i]) <= UNCHANGED &&
      Math.abs(g - b[i + 1]) <= UNCHANGED &&
      Math.abs(bl - b[i + 2]) <= UNCHANGED
    )
      continue;
    o[i] = r;
    o[i + 1] = g;
    o[i + 2] = bl;
    o[i + 3] = 255;
  }
  return out;
}

/** A CSS color (e.g. `var(--ink)`) as RGB, as the page resolves it. */
function cssColor(color: string): [number, number, number] {
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/**
 * The box (snapshot px, clamped to the snapshot, whole px) covering circles
 * given in snapshot px, or null if it's empty.
 */
export function snapshotBox(
  snap: InterfaceSnapshot,
  circles: readonly { x: number; y: number; r: number }[],
): { x0: number; y0: number; w: number; h: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of circles) {
    x0 = Math.min(x0, c.x - c.r);
    y0 = Math.min(y0, c.y - c.r);
    x1 = Math.max(x1, c.x + c.r);
    y1 = Math.max(y1, c.y + c.r);
  }
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(snap.pixels.width, Math.ceil(x1));
  y1 = Math.min(snap.pixels.height, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/** Image px → snapshot px, through the Canvas's `toScreen`. */
export function toSnapshot(
  snap: InterfaceSnapshot,
  toScreen: DOMMatrixReadOnly,
  x: number,
  y: number,
): { x: number; y: number } {
  const c = toScreen.transformPoint(new DOMPoint(x, y));
  return { x: (c.x - snap.x) * snap.scale, y: (c.y - snap.y) * snap.scale };
}

/**
 * The interface's ink, as a raster the acids can spread through: its own
 * colors, with alpha from how dark each pixel is (paper is clear).
 */
export function interfaceInk(src: ImageData): ImageData {
  const out = new ImageData(src.width, src.height);
  const s = src.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const lum = 0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2];
    d[i] = s[i];
    d[i + 1] = s[i + 1];
    d[i + 2] = s[i + 2];
    d[i + 3] = Math.round((255 - lum) * (s[i + 3] / 255));
  }
  return out;
}
