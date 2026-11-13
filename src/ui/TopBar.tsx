import { useRef, useState } from 'react';
import { renderRecipe } from '../core/pipeline';
import { rasterToPngBlob } from '../core/raster';
import { MANIPULATIONS } from '../manipulations';
import { assetResolver } from '../store/assets';
import { loadBundle, saveBundle } from '../store/bundle';
import { useStore } from '../store/store';
import { vectorize, vectorizeOptionsSchema, type VectorizeOptions } from '../vectorize/vectorize';
import { ControlsPanel } from './ControlsPanel';
import { download, timestamp } from './download';

export function TopBar() {
  const manipulationId = useStore((s) => s.recipe.steps[0].manipulationId);
  const selectManipulation = useStore((s) => s.selectManipulation);
  const loadRecipe = useStore((s) => s.loadRecipe);
  const fileInput = useRef<HTMLInputElement>(null);
  const [traceOptions, setTraceOptions] = useState<VectorizeOptions>(() => vectorizeOptionsSchema.parse({}));
  const [busy, setBusy] = useState<string | null>(null);

  const run = (label: string, task: () => Promise<void>) => async () => {
    setBusy(label);
    try {
      await task();
    } catch (e) {
      console.error(e);
      alert(`${label} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const save = run('Save', async () => {
    const { recipe, assetBlobs } = useStore.getState();
    download(await saveBundle(recipe, assetBlobs), `letters-${timestamp()}.zip`);
  });

  const exportPng = run('Export PNG', async () => {
    const output = await renderRecipe(useStore.getState().recipe, assetResolver);
    download(await rasterToPngBlob(output.raster), `letters-${timestamp()}.png`);
  });

  const exportSvg = run('Export SVG', async () => {
    const output = await renderRecipe(useStore.getState().recipe, assetResolver);
    const traced = !output.svg;
    const svg = output.svg ?? (await vectorize(output.raster, traceOptions));
    download(new Blob([svg], { type: 'image/svg+xml' }), `letters-${timestamp()}${traced ? '-traced' : ''}.svg`);
  });

  return (
    <header className="topbar">
      <strong>Letters</strong>
      <select value={manipulationId} onChange={(e) => selectManipulation(0, e.target.value)}>
        {MANIPULATIONS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <span className="spacer" />
      {busy && <span className="busy">{busy}…</span>}
      <button type="button" onClick={save}>
        Save
      </button>
      <button type="button" onClick={() => fileInput.current?.click()}>
        Load
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          run('Load', async () => {
            const { recipe, assetBlobs, warnings } = await loadBundle(file);
            loadRecipe(recipe, assetBlobs, warnings);
          })();
        }}
      />
      <button type="button" onClick={exportPng}>
        Export PNG
      </button>
      <button type="button" onClick={exportSvg}>
        Export SVG
      </button>
      <details className="popover">
        <summary title="Used when the Manipulation has no native vector output">Trace settings</summary>
        <div className="popover-body">
          <p className="hint">Used when the Manipulation has no native vector, so the SVG is traced from pixels.</p>
          <ControlsPanel
            schema={vectorizeOptionsSchema}
            owner="vectorize"
            values={traceOptions}
            onChange={(v) => setTraceOptions(v as VectorizeOptions)}
          />
        </div>
      </details>
    </header>
  );
}
