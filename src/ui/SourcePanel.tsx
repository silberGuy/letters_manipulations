import { sourceTypeSchema, type Source } from '../core/recipe';
import { useStore } from '../store/store';
import { ControlsPanel } from './ControlsPanel';
import { FontPicker } from './FontPicker';

export function SourcePanel() {
  const source = useStore((s) => s.recipe.source);
  const setSource = useStore((s) => s.setSource);

  return (
    <aside className="panel">
      <h2>Source</h2>
      <label className="control">
        <span className="control-label muted">Text</span>
        <textarea className="input source-text" dir="auto" rows={3} value={source.text} onChange={(e) => setSource({ text: e.target.value })} />
      </label>
      <FontPicker value={source.font} onChange={(font) => setSource({ font })} />
      <ControlsPanel schema={sourceTypeSchema} owner="source" values={source}
        onChange={(v) => setSource(v as Partial<Source>)}
      />
    </aside>
  );
}
