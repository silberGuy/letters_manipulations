/**
 * Raster helpers. The pipeline passes `ImageData` between stages (see ADR 0001).
 *
 * Ink convention: the Source is black ink on transparent paper, so alpha is
 * the ink coverage. Manipulations accept any RGBA, but mask-style ones can read
 * `coverage()` and write back with `inkFromCoverage()`.
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

/** Black ink whose alpha is the given 0..1 coverage. */
export function inkFromCoverage(cov: Float32Array, width: number, height: number): ImageData {
  const image = createRaster(width, height);
  const d = image.data;
  for (let i = 0; i < cov.length; i++) d[i * 4 + 3] = Math.round(cov[i] * 255);
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
