import { getManipulation } from '../manipulations';
import type { AssetResolver, Output } from './manipulation';
import { rasterizeSource } from './rasterizeSource';
import type { Recipe, Step } from './recipe';
import { identityRemap, throughDisplacement, type Displacement, type Remap } from './remap';
import { createRng } from './rng';

export function runStep(step: Step, input: ImageData, assets: AssetResolver): Promise<Output> {
  const m = getManipulation(step.manipulationId);
  return m.render({ input, params: step.params, state: step.state, rng: createRng(step.seed), assets, quality: 'final' });
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

function displacementOf(step: Step | null): Displacement | null {
  if (!step) return null;
  return getManipulation(step.manipulationId).displacement?.(step.state) ?? null;
}

/**
 * Move every Step's State along with `remap`, a move of the first Step's input
 * (see Manipulation.remapState). Steps that move points (Manipulation.displacement)
 * carry it through to the Steps after them.
 */
export function remapSteps(steps: Step[], remap: Remap): Step[] {
  let r = remap;
  return steps.map((step) => {
    const m = getManipulation(step.manipulationId);
    const next = m.remapState ? { ...step, state: m.remapState(step.state, r) } : step;
    r = throughDisplacement(r, displacementOf(step), displacementOf(next));
    return next;
  });
}

/**
 * Replace Step `i` (or remove it, with null). When that changes how it moves
 * points, later Steps' State moves along, e.g. effects after a Crack Step
 * follow the pixels when another Crack opens.
 */
export function replaceStep(steps: Step[], i: number, next: Step | null): Step[] {
  const prev = steps[i];
  const later = steps.slice(i + 1);
  const unchanged = next && next.manipulationId === prev.manipulationId && next.state === prev.state;
  const remap = unchanged ? identityRemap : throughDisplacement(identityRemap, displacementOf(prev), displacementOf(next));
  return [...steps.slice(0, i), ...(next ? [next] : []), ...(remap === identityRemap ? later : remapSteps(later, remap))];
}
