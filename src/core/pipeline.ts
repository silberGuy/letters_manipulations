import { getManipulation } from '../manipulations';
import type { AssetResolver, Output } from './manipulation';
import { rasterizeSource } from './rasterizeSource';
import type { Recipe, Step } from './recipe';
import { createRng } from './rng';

export function runStep(step: Step, input: ImageData, assets: AssetResolver): Promise<Output> {
  const m = getManipulation(step.manipulationId);
  return m.render({ input, params: step.params, state: step.state, rng: createRng(step.seed), assets });
}

/** The input for step `stepIndex`: the Source, run through every earlier Step. */
export async function renderInput(
  recipe: Pick<Recipe, 'source' | 'steps'>,
  stepIndex: number,
  assets: AssetResolver,
): Promise<ImageData> {
  let raster = await rasterizeSource(recipe.source);
  for (const step of recipe.steps.slice(0, stepIndex)) raster = (await runStep(step, raster, assets)).raster;
  return raster;
}

/** Replay a whole Recipe without any UI. */
export async function renderRecipe(recipe: Recipe, assets: AssetResolver): Promise<Output> {
  const last = recipe.steps.length - 1;
  return runStep(recipe.steps[last], await renderInput(recipe, last, assets), assets);
}
