/**
 * Raster helpers. The pipeline passes `ImageData` between stages (see ADR 0001).
 *
 * Ink convention: the Source is ink (in the Source's color) on transparent
 * paper, so alpha is the ink coverage. Manipulations accept any RGBA, but
 * mask-style ones can read `coverage()` and write back with
 * `inkFromCoverage()`, passing `inkColor()` of their input to keep the color.
 */

export function createRaster(width: number, height: number): ImageData {
  return new ImageData(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

export function cloneRaster(image: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
}

/** Alpha channel as 0..1 coverage, one value per pixel. */
export function coverage(image: ImageData): Float32Array {
  const out = new Float32Array(image.width * image.height);
  const d = image.data;
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] / 255;
  return out;
}

export type Rgb = [number, number, number];

/** The ink's average color, weighted by coverage. Black when there's no ink. */
export function inkColor(image: ImageData): Rgb {
  const d = image.data;
  let r = 0, g = 0, b = 0, total = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    r += d[i] * a;
    g += d[i + 1] * a;
    b += d[i + 2] * a;
    total += a;
  }
  return total ? [Math.round(r / total), Math.round(g / total), Math.round(b / total)] : [0, 0, 0];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Ink of the given color whose alpha is the given 0..1 coverage. */
export function inkFromCoverage(cov: Float32Array, width: number, height: number, color: Rgb = [0, 0, 0]): ImageData {
  const image = createRaster(width, height);
  const d = image.data;
  for (let i = 0; i < cov.length; i++) {
    d[i * 4] = color[0];
    d[i * 4 + 1] = color[1];
    d[i * 4 + 2] = color[2];
    d[i * 4 + 3] = Math.round(cov[i] * 255);
  }
  return image;
}

export function rasterToCanvas(image: ImageData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas;
}

export function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

export function rasterToPngBlob(image: ImageData): Promise<Blob> {
  return rasterToCanvas(image).convertToBlob({ type: 'image/png' });
}
