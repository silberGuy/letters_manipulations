import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Updater } from '../core/manipulation';
import { remapSteps, renderInput } from '../core/pipeline';
import type { Recipe } from '../core/recipe';
import { remapBetween } from '../core/remap';
import { getManipulation } from '../manipulations';
import { assetResolver } from '../store/assets';
import { useStore } from '../store/store';

type Values = Record<string, unknown>;

/**
 * The input to step `stepIndex`. Keeps the previous input on screen while
 * recomputing. When the Source changed, moves State along with the text at the
 * same moment the new input appears.
 */
function useStepInput(recipe: Recipe, stepIndex: number) {
  const [input, setInput] = useState<ImageData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Only the Source and earlier Steps affect this Step's input.
  const key = JSON.stringify([recipe.source, recipe.steps.slice(0, stepIndex)]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const from = useStore.getState().anchoredTo;
      const remap = await remapBetween(from, recipe.source);
      const steps = remap ? remapSteps(recipe.steps, remap) : recipe.steps;
      const raster = await renderInput({ source: recipe.source, steps }, stepIndex, assetResolver);
      if (cancelled) return;
      if (remap) useStore.getState().applyRemap(from, recipe.source, remap);
      setInput(raster);
      setError(null);
    })().catch((e) => !cancelled && setError(e instanceof Error ? e : new Error(String(e))));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { input, error };
}

export function Editor({ stepIndex }: { stepIndex: number }) {
  const recipe = useStore((s) => s.recipe);
  const storedTools = useStore((s) => s.tools[recipe.steps[stepIndex].manipulationId]);
  const step = recipe.steps[stepIndex];
  const m = getManipulation(step.manipulationId);
  const tools = useMemo(() => storedTools ?? m.toolsSchema.parse({}), [storedTools, m]);
  const { input, error } = useStepInput(recipe, stepIndex);

  const setParams = useCallback((u: Updater<Values>) => useStore.getState().setParams(stepIndex, u), [stepIndex]);
  const setState = useCallback((u: Updater<Values>) => useStore.getState().setState(stepIndex, u), [stepIndex]);

  return (
    <main className="editor">
      {error && <div className="output-status error">Source failed: {error.message}</div>}
      {input ? (
        <m.Component
          // Remount on Manipulation switch so editors don't share local state.
          key={m.id}
          input={input}
          params={step.params}
          setParams={setParams}
          state={step.state}
          setState={setState}
          tools={tools}
          seed={step.seed}
          assets={assetResolver}
        />
      ) : (
        !error && <div className="output-status">Loading font…</div>
      )}
    </main>
  );
}
