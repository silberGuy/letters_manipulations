/**
 * Gaussian blur of a single float channel, approximated by three box blurs.
 * Pixels outside the field count as 0. Deterministic and browser-independent.
 */
export function gaussianBlur(src: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma < 0.5) return src.slice();
  let a = src.slice();
  let b = new Float32Array(src.length);
  for (const size of boxSizesForGauss(sigma, 3)) {
    const r = (size - 1) / 2;
    boxBlurH(a, b, width, height, r);
    boxBlurV(b, a, width, height, r);
  }
  return a;
}

/** Extra margin to add around a field so a blur of `sigma` isn't clipped. */
export function blurMargin(sigma: number): number {
  return sigma < 0.5 ? 0 : Math.ceil(sigma * 3) + 1;
}

function boxSizesForGauss(sigma: number, n: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const m = Math.round((12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) / (-4 * lower - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? lower : upper));
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[row + x];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * inv;
      if (x + r + 1 < w) acc += src[row + x + r + 1];
      if (x - r >= 0) acc -= src[row + x - r];
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) acc += src[y * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv;
      if (y + r + 1 < h) acc += src[(y + r + 1) * w + x];
      if (y - r >= 0) acc -= src[(y - r) * w + x];
    }
  }
}
