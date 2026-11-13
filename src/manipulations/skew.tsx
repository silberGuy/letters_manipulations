import { z } from 'zod';
import { enumField, numberField } from '../core/fields';
import { defineManipulation, type RenderContext } from '../core/manipulation';
import { context2d, rasterToCanvas } from '../core/raster';
import { PreviewEditor } from './PreviewEditor';

const paramsSchema = z.object({
  angle: numberField({ label: 'Angle (°)', min: -75, max: 75, step: 0.5, default: 15 }),
  axis: enumField(['horizontal', 'vertical'], { label: 'Axis', default: 'horizontal' }),
});
const stateSchema = z.object({});
const toolsSchema = z.object({});

type Params = z.output<typeof paramsSchema>;

/** Shear the image; the Output grows to fit. Positive angles lean right / down. */
async function render({ input, params }: RenderContext<Params, unknown>) {
  const t = Math.tan((params.angle * Math.PI) / 180);
  const { width: w, height: h } = input;
  const horizontal = params.axis === 'horizontal';
  const out = horizontal
    ? new OffscreenCanvas(Math.ceil(w + Math.abs(t) * h), h)
    : new OffscreenCanvas(w, Math.ceil(h + Math.abs(t) * w));
  const ctx = context2d(out);
  ctx.imageSmoothingQuality = 'high';
  if (horizontal) ctx.setTransform(1, 0, -t, 1, t > 0 ? t * h : 0, 0);
  else ctx.setTransform(1, -t, 0, 1, 0, t > 0 ? t * w : 0);
  ctx.drawImage(rasterToCanvas(input), 0, 0);
  return { raster: ctx.getImageData(0, 0, out.width, out.height) };
}

export const skew = defineManipulation({
  id: 'skew',
  version: 1,
  label: 'Skew',
  paramsSchema,
  stateSchema,
  toolsSchema,
  render,
  Component: (props) => <PreviewEditor {...props} render={render} />,
});
