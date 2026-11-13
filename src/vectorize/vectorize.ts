import { z } from 'zod';
import { numberField } from '../core/fields';

/**
 * Trace a raster's ink into SVG with Potrace. Ink is read from alpha
 * (coverage), so it works on anything that follows the ink convention.
 *
 * A Manipulation that vectorizes inside its own render can spread
 * `vectorizeOptionsSchema.shape` into its paramsSchema so the settings land in
 * the Recipe.
 */
export const vectorizeOptionsSchema = z.object({
  threshold: numberField({ label: 'Trace threshold', min: 0.01, max: 0.99, step: 0.01, default: 0.5 }),
  speckle: numberField({ label: 'Remove specks (px²)', min: 0, max: 200, default: 2 }),
  smoothness: numberField({ label: 'Corner smoothness', min: 0, max: 1.34, step: 0.01, default: 1 }),
  tolerance: numberField({ label: 'Curve tolerance', min: 0, max: 1, step: 0.05, default: 0.2 }),
});
export type VectorizeOptions = z.output<typeof vectorizeOptionsSchema>;

interface PotraceModule {
  init(): Promise<unknown>;
  potrace(image: ImageData, options: Record<string, unknown>): Promise<string>;
}

let modulePromise: Promise<PotraceModule> | null = null;

function loadPotrace(): Promise<PotraceModule> {
  modulePromise ??= (async () => {
    // @ts-ignore -- the package may not ship type declarations
    const mod = (await import('esm-potrace-wasm')) as PotraceModule;
    await mod.init();
    return mod;
  })();
  return modulePromise;
}

/** Opaque black-on-white image: unambiguous input for Potrace. */
function binarize(image: ImageData, threshold: number): ImageData {
  const out = new ImageData(image.width, image.height);
  const cut = threshold * 255;
  for (let i = 0; i < image.data.length; i += 4) {
    const v = image.data[i + 3] >= cut ? 0 : 255;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

export async function vectorize(image: ImageData, options: VectorizeOptions): Promise<string> {
  const { potrace } = await loadPotrace();
  return potrace(binarize(image, options.threshold), {
    turdsize: options.speckle,
    turnpolicy: 4,
    alphamax: options.smoothness,
    opticurve: 1,
    opttolerance: options.tolerance,
    pathonly: false,
    extractcolors: false,
    posterizelevel: 2,
    posterizationalgorithm: 0,
  });
}
