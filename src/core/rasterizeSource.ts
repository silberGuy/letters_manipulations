import { applyTextStyle, measureSource } from './layout';
import { context2d } from './raster';
import type { Source } from './recipe';

/**
 * Draw the Source as ink in its color on transparent paper. The canvas is fitted to
 * the text plus padding.
 */
export async function rasterizeSource(source: Source): Promise<ImageData> {
  const metrics = await measureSource(source);
  const canvas = new OffscreenCanvas(metrics.width, metrics.height);
  const ctx = context2d(canvas);
  applyTextStyle(ctx, metrics.fontString, source.letterSpacing);
  ctx.fillStyle = source.color;

  for (const line of metrics.lines) {
    ctx.direction = line.direction;
    ctx.fillText(line.text, line.x, line.baseline);
  }

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
