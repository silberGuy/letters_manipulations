import type { RenderResult } from '../core/useRender';

export function OutputStatus({ result }: { result: RenderResult }) {
  if (result.error) return <div className="output-status error">Render failed: {result.error.message}</div>;
  if (result.pending) return <div className="output-status">Rendering…</div>;
  return null;
}
