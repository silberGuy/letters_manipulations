import { z } from 'zod';
import { blurMargin, gaussianBlur } from '../core/blur';
import { numberField } from '../core/fields';
import { defineManipulation, type RenderContext } from '../core/manipulation';
import { coverage, inkFromCoverage } from '../core/raster';
import { PreviewEditor } from './PreviewEditor';

const paramsSchema = z.object({
  radius: numberField({ label: 'Blur radius', min: 0, max: 80, step: 0.5, default: 10 }),
  threshold: numberField({ label: 'Threshold', min: 0.01, max: 0.99, step: 0.01, default: 0.5 }),
  softness: numberField({ label: 'Edge softness', min: 0, max: 0.5, step: 0.005, default: 0.03 }),
});
const stateSchema = z.object({});
const toolsSchema = z.object({});

type Params = z.output<typeof paramsSchema>;

/** Blur the ink, then threshold it back into crisp shapes: letters melt together. */
async function render({ input, params }: RenderContext<Params, unknown>) {
  const { radius, threshold, softness } = params;
  const margin = blurMargin(radius);
  const w = input.width + margin * 2;
  const h = input.height + margin * 2;

  const src = coverage(input);
  const field = new Float32Array(w * h);
  for (let y = 0; y < input.height; y++) {
    field.set(src.subarray(y * input.width, (y + 1) * input.width), (y + margin) * w + margin);
  }

  const blurred = gaussianBlur(field, w, h, radius);
  const lo = threshold - softness / 2;
  const hi = threshold + softness / 2;
  for (let i = 0; i < blurred.length; i++) {
    const v = blurred[i];
    if (hi <= lo) blurred[i] = v >= threshold ? 1 : 0;
    else {
      const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
      blurred[i] = t * t * (3 - 2 * t);
    }
  }
  return { raster: inkFromCoverage(blurred, w, h) };
}

export const goo = defineManipulation({
  id: 'goo',
  version: 1,
  label: 'Goo',
  paramsSchema,
  stateSchema,
  toolsSchema,
  render,
  Component: (props) => <PreviewEditor {...props} render={render} />,
});
