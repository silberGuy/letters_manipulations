import { z } from 'zod';
import { enumField, numberField } from '../core/fields';
import { defineManipulation, type RenderContext } from '../core/manipulation';
import { createRaster, samplerFor } from '../core/raster';
import { PreviewEditor } from './PreviewEditor';

const paramsSchema = z.object({
  angle: numberField({ label: 'Angle (°)', min: -75, max: 75, step: 0.5, default: 15 }),
  axis: enumField(['horizontal', 'vertical'], { label: 'Axis', default: 'horizontal' }),
});
const stateSchema = z.object({});
const toolsSchema = z.object({});

type Params = z.output<typeof paramsSchema>;

/**
 * Shear the image; the Output grows to fit. Positive angles lean right / down.
 * Samples each Output pixel from the input ourselves rather than letting the
 * canvas resample, which blurs a soft halo around the shape and differs
 * between browsers.
 */
async function render({ input, params, quality }: RenderContext<Params, unknown>) {
  const sample = samplerFor(quality);
  const t = Math.tan((params.angle * Math.PI) / 180);
  const { width: w, height: h, data: src } = input;
  const horizontal = params.axis === 'horizontal';
  const out = horizontal
    ? createRaster(Math.ceil(w + Math.abs(t) * h), h)
    : createRaster(w, Math.ceil(h + Math.abs(t) * w));
  const { width: W, height: H, data: dst } = out;
  // Output = input sheared, then shifted so nothing lands at negative coordinates.
  const shift = t > 0 ? t * (horizontal ? h : w) : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Inverse of the shear, at the pixel's center.
      const cx = x + 0.5;
      const cy = y + 0.5;
      const sx = horizontal ? cx - shift + t * cy : cx;
      const sy = horizontal ? cy : cy - shift + t * cx;
      sample(src, w, h, sx - 0.5, sy - 0.5, dst, (y * W + x) * 4);
    }
  }
  return { raster: out };
}

export const skew = defineManipulation({
  id: 'skew',
  version: 2,
  label: 'Skew',
  paramsSchema,
  stateSchema,
  toolsSchema,
  render,
  Component: (props) => <PreviewEditor {...props} render={render} />,
});
