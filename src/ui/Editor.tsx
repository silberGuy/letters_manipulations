import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Updater } from '../core/manipulation';
import { remapSteps, renderInput, renderRecipe } from '../core/pipeline';
import type { Recipe } from '../core/recipe';
import { remapBetween } from '../core/remap';
import { getManipulation } from '../manipulations';
import { assetResolver } from '../store/assets';
import { useStore } from '../store/store';
import { RasterView } from './RasterView';

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

/** The Recipe's Output, view-only. Brings State up to date with the Source first. */
function FinalView() {
  const recipe = useStore((s) => s.recipe);
  const [image, setImage] = useState<ImageData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(true);
  const key = JSON.stringify([recipe.source, recipe.steps]);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    (async () => {
      const output = await renderRecipe(await useStore.getState().reconcile(), assetResolver);
      if (cancelled) return;
      setImage(output.raster);
      setError(null);
      setPending(false);
    })().catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setPending(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <>
      <RasterView image={image} />
      {error ? (
        <div className="output-status error">Render failed: {error.message}</div>
      ) : (
        pending && <div className="output-status">Rendering…</div>
      )}
    </>
  );
}

/** Floats under the top bar on every tab but the last. */
function FinalToggle() {
  const showFinal = useStore((s) => s.showFinal);
  const setShowFinal = useStore((s) => s.setShowFinal);
  return (
    <div className="final-toggle row">
      <button type="button" className={`btn${showFinal ? ' btn-outline' : ''}`} onClick={() => setShowFinal(false)}>
        Up to this step
      </button>
      <button type="button" className={`btn${showFinal ? '' : ' btn-outline'}`} onClick={() => setShowFinal(true)}>
        Final result
      </button>
    </div>
  );
}

export function Editor({ stepIndex }: { stepIndex: number }) {
  const isLast = useStore((s) => stepIndex === s.recipe.steps.length - 1);
  const showFinal = useStore((s) => s.showFinal) && !isLast;
  return (
    <main className="editor">
      {!isLast && <FinalToggle />}
      {showFinal ? <FinalView /> : <StepEditor key={stepIndex} stepIndex={stepIndex} />}
    </main>
  );
}

function StepEditor({ stepIndex }: { stepIndex: number }) {
  const recipe = useStore((s) => s.recipe);
  const storedTools = useStore((s) => s.tools[recipe.steps[stepIndex].manipulationId]);
  const step = recipe.steps[stepIndex];
  const m = getManipulation(step.manipulationId);
  const tools = useMemo(() => storedTools ?? m.toolsSchema.parse({}), [storedTools, m]);
  const { input, error } = useStepInput(recipe, stepIndex);

  const setParams = useCallback((u: Updater<Values>) => useStore.getState().setParams(stepIndex, u), [stepIndex]);
  const setState = useCallback((u: Updater<Values>) => useStore.getState().setState(stepIndex, u), [stepIndex]);

  return (
    <>
      {error && (
        <div className="output-status error">
          {stepIndex === 0 ? 'Source' : 'Input'} failed: {error.message}
        </div>
      )}
      {input ? (
        <m.Component
          // Remount on Step or Manipulation switch so editors don't share local state.
          key={`${stepIndex}:${m.id}`}
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
        !error && <div className="output-status">{stepIndex === 0 ? 'Loading font…' : 'Rendering earlier steps…'}</div>
      )}
    </>
  );
}
