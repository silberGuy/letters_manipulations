import { useEffect, useState } from 'react';
import type { AssetResolver, Output, RenderContext } from './manipulation';
import { createRng } from './rng';

export interface RenderResult {
  output: Output | null;
  error: Error | null;
  pending: boolean;
}

/**
 * Runs a Manipulation's render for the live preview. Debounces to a frame,
 * drops results from stale inputs, and keeps the last good output on screen
 * while a new one is computing.
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
    setResult((r) => ({ ...r, pending: true }));
    const timer = setTimeout(async () => {
      try {
        const output = await render({ input, params, state, rng: createRng(seed), assets });
        if (!cancelled) setResult({ output, error: null, pending: false });
      } catch (e) {
        if (!cancelled)
          setResult((r) => ({ ...r, error: e instanceof Error ? e : new Error(String(e)), pending: false }));
      }
    }, 16);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [render, input, params, state, seed, assets]);

  return result;
}
