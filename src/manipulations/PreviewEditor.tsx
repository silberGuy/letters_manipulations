import type { EditorProps, Output, RenderContext } from '../core/manipulation';
import { useRender } from '../core/useRender';
import { OutputStatus } from '../ui/OutputStatus';
import { RasterView } from '../ui/RasterView';

/**
 * Editor for Manipulations with no on-canvas interaction: renders the Output
 * and shows it. Params are edited from the generated panel.
 */
export function PreviewEditor<P, S, T>({
  render,
  input,
  params,
  state,
  seed,
  assets,
}: EditorProps<P, S, T> & { render: (ctx: RenderContext<P, S>) => Promise<Output> }) {
  const result = useRender(render, input, params, state, seed, assets);
  return (
    <>
      <RasterView image={result.output?.raster ?? null} />
      <OutputStatus result={result} />
    </>
  );
}
