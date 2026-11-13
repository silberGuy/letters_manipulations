import type { Rng } from './rng';

/** A random event around a center: when it happens, where, and two spare draws. */
export interface Candidate {
  /** Seconds since the start. */
  t: number;
  x: number;
  y: number;
  /** Uniform in [0, 1), for the caller to use as it likes. */
  sizeDraw: number;
  keep: number;
}

/** Side of a tile (px). Each tile has its own random stream. */
const TILE = 64;

/**
 * Poisson-in-time candidates spread uniformly over the square of half-side
 * `radius` around (cx, cy), sorted by time, up to `duration`.
 *
 * The square is tiled in the center's own frame, and each tile draws from its
 * own stream, so:
 * - moving the center moves every candidate with it, rigidly;
 * - a longer duration or bigger radius only adds candidates: ones that come
 *   later, or lie farther out (prefix-stable, so live previews grow smoothly).
 */
export function candidatesAround(
  rng: Rng,
  cx: number,
  cy: number,
  radius: number,
  /** Candidates per px² per second. */
  rate: number,
  duration: number,
): Candidate[] {
  const out: Candidate[] = [];
  const tileRate = rate * TILE * TILE;
  if (!(tileRate > 0) || !(duration > 0)) return out;
  const lo = Math.floor(-radius / TILE);
  const hi = Math.floor(radius / TILE);
  for (let j = lo; j <= hi; j++) {
    for (let i = lo; i <= hi; i++) {
      const tile = rng.fork(`${i},${j}`);
      let t = 0;
      for (;;) {
        // Draw every value up front, so later candidates never depend on how earlier ones are used.
        t += -Math.log(1 - tile.next()) / tileRate;
        const u = tile.next();
        const v = tile.next();
        const sizeDraw = tile.next();
        const keep = tile.next();
        if (t > duration) break;
        out.push({ t, x: cx + (i + u) * TILE, y: cy + (j + v) * TILE, sizeDraw, keep });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
