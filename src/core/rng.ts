/**
 * Seeded randomness. Manipulations must draw all randomness from the Rng they
 * are given — never Math.random — so a Recipe reproduces exactly.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  gaussian(mean?: number, sd?: number): number;
  /**
   * An independent stream derived from this Rng's seed and a label. Draws from
   * a fork don't shift draws from the parent (or other forks), so adding a new
   * random feature doesn't change existing ones.
   */
  fork(label: string): Rng;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    pick(items) {
      if (items.length === 0) throw new Error('Rng.pick: empty list');
      return items[Math.floor(next() * items.length)];
    },
    gaussian(mean = 0, sd = 1) {
      const u = 1 - next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    fork: (label) => createRng((seed ^ hashString(label)) >>> 0),
  };
}

/** A fresh seed for new Steps and rerolls (not for use inside render). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
