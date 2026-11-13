import { cachedLayout, type Glyph, type SourceLayout } from './layout';
import type { Source } from './recipe';

export interface Point {
  x: number;
  y: number;
}

export interface Located {
  /** Where the point goes in the new image. */
  to: Point;
  /**
   * The glyph under (or nearest to) the point was deleted. `to` then keeps the
   * point in place next to the nearest surviving glyph, so a Manipulation may
   * keep it there or drop the effect.
   */
  deleted: boolean;
}

/**
 * How positions in an image of one Source move to the image of an edited
 * Source: each point follows the glyph it sits on (or the nearest one).
 */
export interface Remap {
  locate(p: Point): Located;
  /** Shorthand for locate(p).to. */
  point(p: Point): Point;
  /** New em ÷ old em. Multiply lengths (radii, widths, speeds) by it. */
  scale: number;
}

/**
 * Pair old glyphs with new ones. Each Source edit is one splice (a typed key,
 * a deletion, a paste over a selection), so matching the common start and end
 * finds it. A same-length splice is a replacement: those glyphs pair up one to
 * one, so retyping a letter keeps its effects. Otherwise the old middle glyphs
 * are deleted. Returns the new index of each old glyph, or -1.
 */
function matchGlyphs(from: Glyph[], to: Glyph[]): number[] {
  const n = from.length;
  const m = to.length;
  let start = 0;
  while (start < n && start < m && from[start].text === to[start].text) start++;
  let end = 0;
  while (end < n - start && end < m - start && from[n - 1 - end].text === to[m - 1 - end].text) end++;

  const replaced = n - start - end === m - start - end;
  return from.map((_, i) => {
    if (i < start) return i;
    if (i >= n - end) return i - n + m;
    return replaced ? i : -1;
  });
}

function distanceToBox(p: Point, g: Glyph): number {
  const dx = Math.max(g.x0 - p.x, 0, p.x - g.x1);
  const dy = Math.max(g.y0 - p.y, 0, p.y - g.y1);
  return Math.hypot(dx, dy);
}

/** The glyph a point belongs to: the one it's inside, else the nearest. */
function owner(p: Point, glyphs: Glyph[]): number {
  let best = -1;
  let bestDist = Infinity;
  glyphs.forEach((g, i) => {
    // Whitespace glyphs only claim points inside them, so marks on a letter's
    // edge don't jump to a neighbouring space.
    const d = distanceToBox(p, g) + (g.text.trim() === '' ? 1e-3 : 0);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

export function buildRemap(from: SourceLayout, to: SourceLayout): Remap {
  const scale = to.em / from.em;
  const match = matchGlyphs(from.glyphs, to.glyphs);

  /** Move p with old glyph i, which survives as new glyph j. */
  const follow = (p: Point, i: number, j: number): Point => {
    const a = from.glyphs[i];
    const b = to.glyphs[j];
    return { x: b.x0 + (p.x - a.x0) * scale, y: b.y0 + (p.y - a.y0) * scale };
  };

  /** The nearest surviving glyph to old glyph i in typing order, preferring the one before. */
  const survivor = (i: number): number => {
    for (let d = 1; d < from.glyphs.length; d++) {
      if (i - d >= 0 && match[i - d] >= 0) return i - d;
      if (i + d < from.glyphs.length && match[i + d] >= 0) return i + d;
    }
    return -1;
  };

  const locate = (p: Point): Located => {
    const i = owner(p, from.glyphs);
    if (i < 0) return { to: p, deleted: false }; // No old text: nothing to follow.
    if (match[i] >= 0) return { to: follow(p, i, match[i]), deleted: false };
    const k = survivor(i);
    return { to: k >= 0 ? follow(p, k, match[k]) : p, deleted: true };
  };

  return {
    locate,
    point: (p) => locate(p).to,
    scale,
  };
}

/** How remapItems treats one kind of item (a hole, a press, a Cut). */
export interface ItemRemap<T> {
  /** Points that say where the item lives, e.g. its center, or its stroke. */
  samples(item: T): Point[];
  /** Drop the item when more than this share of its samples were on deleted letters. */
  dropAbove: number;
  /** Move a kept item, given where each of its samples went (in `samples` order). */
  move(item: T, located: Located[]): T;
}

/**
 * Remap a list of items for a Manipulation's remapState: items mostly on
 * deleted letters are dropped, the rest moved. Keeps the order of kept items.
 */
export function remapItems<T>(items: readonly T[], remap: Remap, how: ItemRemap<T>): T[] {
  return items.flatMap((item) => {
    const located = how.samples(item).map((p) => remap.locate(p));
    const deleted = located.filter((l) => l.deleted).length;
    if (located.length > 0 && deleted / located.length > how.dropAbove) return [];
    return [how.move(item, located)];
  });
}

/** The Remap from one Source to another, or null when they lay out the same. */
export async function remapBetween(from: Source, to: Source): Promise<Remap | null> {
  if (from === to || JSON.stringify(from) === JSON.stringify(to)) return null;
  const [a, b] = await Promise.all([cachedLayout(from), cachedLayout(to)]);
  return buildRemap(a, b);
}
