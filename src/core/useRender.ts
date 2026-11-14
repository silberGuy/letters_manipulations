import { useEffect, useState } from 'react';
import type { AssetResolver, Output, RenderContext, RenderQuality } from './manipulation';
import { createRng } from './rng';

export interface RenderResult {
  output: Output | null;
  error: Error | null;
  pending: boolean;
}

/** How long (ms) inputs must stay unchanged before the final-quality render. */
const FINAL_DELAY = 250;

/**
 * Runs a Manipulation's render for the live preview. Debounces to a frame,
 * drops results from stale inputs, and keeps the last good output on screen
 * while a new one is computing.
 *
 * Renders a `draft` first; once the inputs have settled for FINAL_DELAY, it
 * re-renders as `final`. The second render only happens if the draft one read
 * `quality`, so Manipulations that ignore it never render twice. `pending`
 * clears once the draft lands, so editors that animate on each result keep
 * their pace.
 */
export function useRender<P, S>(
  render: (ctx: RenderContext<P, S>) => Promise<Output>,
  input: ImageData,
  params: P,
  state: S,
  seed: number,
  assets: AssetResolver,
): RenderResult {
  const [result, setResult] = useState<RenderResult>({ output: null, error: null, pending: true });

  useEffect(() => {
    let cancelled = false;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;

    const run = async (quality: RenderQuality) => {
      let readQuality = false;
      const ctx: RenderContext<P, S> = {
        input,
        params,
        state,
        rng: createRng(seed),
        assets,
        get quality() {
          readQuality = true;
          return quality;
        },
      };
      const output = await render(ctx);
      return { output, readQuality };
    };
    const fail = (e: unknown) => {
      if (!cancelled)
        setResult((r) => ({ ...r, error: e instanceof Error ? e : new Error(String(e)), pending: false }));
    };

    setResult((r) => ({ ...r, pending: true }));
    const timer = setTimeout(async () => {
      try {
        const draft = await run('draft');
        if (cancelled) return;
        setResult({ output: draft.output, error: null, pending: false });
        if (!draft.readQuality) return;
        finalTimer = setTimeout(async () => {
          try {
            const final = await run('final');
            if (!cancelled) setResult({ output: final.output, error: null, pending: false });
          } catch (e) {
            fail(e);
          }
        }, FINAL_DELAY);
      } catch (e) {
        fail(e);
      }
    }, 16);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(finalTimer);
    };
  }, [render, input, params, state, seed, assets]);

  return result;
}
