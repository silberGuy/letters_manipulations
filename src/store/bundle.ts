import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { recipeSchema, type Recipe } from '../core/recipe';
import { getFontLoader } from '../fonts';
import { getManipulation } from '../manipulations';

/**
 * A saved Recipe is a .zip: `recipe.json` plus `assets/<hash>` for every Asset.
 */
export async function saveBundle(recipe: Recipe, assetBlobs: Record<string, Blob>): Promise<Blob> {
  const files: Record<string, Uint8Array> = {
    'recipe.json': strToU8(JSON.stringify(recipe, null, 2)),
  };
  for (const hash of Object.keys(recipe.assets)) {
    const blob = assetBlobs[hash];
    if (!blob) throw new Error(`Missing asset ${hash}`);
    files[`assets/${hash}`] = new Uint8Array(await blob.arrayBuffer());
  }
  return new Blob([new Uint8Array(zipSync(files))], { type: 'application/zip' });
}

export interface LoadedBundle {
  recipe: Recipe;
  assetBlobs: Record<string, Blob>;
  warnings: string[];
}

/** Read and validate a saved Recipe. Throws on anything that can't be reproduced. */
export async function loadBundle(file: Blob): Promise<LoadedBundle> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const json = files['recipe.json'];
  if (!json) throw new Error('Not a recipe: recipe.json is missing');
  const raw = recipeSchema.parse(JSON.parse(strFromU8(json)));
  const warnings: string[] = [];

  const loader = getFontLoader(raw.source.font.loader);
  loader.argsSchema.parse(raw.source.font.args);

  const steps = raw.steps.map((step, i) => {
    const m = getManipulation(step.manipulationId);
    if (step.version !== m.version) {
      warnings.push(
        `Step ${i + 1} (${m.label}) was saved with version ${step.version}; current is ${m.version}. ` +
          'The output may differ from the original.',
      );
    }
    return { ...step, params: m.paramsSchema.parse(step.params), state: m.stateSchema.parse(step.state) };
  });

  const assetBlobs: Record<string, Blob> = {};
  for (const [hash, { mime }] of Object.entries(raw.assets)) {
    const bytes = files[`assets/${hash}`];
    if (!bytes) throw new Error(`Recipe is missing asset ${hash}`);
    assetBlobs[hash] = new Blob([new Uint8Array(bytes)], { type: mime });
  }

  return { recipe: { ...raw, steps }, assetBlobs, warnings };
}
