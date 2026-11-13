import { useMemo } from 'react';
import { describeFields } from '../core/fields';
import { randomSeed } from '../core/rng';
import { getManipulation } from '../manipulations';
import { useStore } from '../store/store';
import { ControlsPanel } from './ControlsPanel';

export function StepPanel({ stepIndex }: { stepIndex: number }) {
  const step = useStore((s) => s.recipe.steps[stepIndex]);
  const storedTools = useStore((s) => s.tools[step.manipulationId]);
  const { setParams, setTools, setSeed, resetStep } = useStore.getState();
  const m = getManipulation(step.manipulationId);
  const tools = useMemo(() => storedTools ?? m.toolsSchema.parse({}), [storedTools, m]);
  const hasParams = describeFields(m.paramsSchema, m.id).length > 0;
  const hasTools = describeFields(m.toolsSchema, m.id).length > 0;

  return (
    <aside className="panel">
      <h2>{m.label}</h2>
      {hasParams && (
        <section>
          <h3>Params</h3>
          <ControlsPanel
            schema={m.paramsSchema}
            owner={`${m.id} params`}
            values={step.params}
            onChange={(v) => setParams(stepIndex, v)}
          />
        </section>
      )}
      {hasTools && (
        <section>
          <h3>Tools</h3>
          <ControlsPanel schema={m.toolsSchema} owner={`${m.id} tools`} values={tools} onChange={(v) => setTools(m.id, v)} />
        </section>
      )}
      <button type="button" onClick={() => resetStep(stepIndex)}>
        Reset
      </button>
      <details className="advanced">
        <summary>Advanced settings</summary>
        <label className="control">
          <span className="control-label">Seed</span>
          <span className="control-row">
            <input
              type="number"
              step={1}
              value={step.seed}
              onChange={(e) => Number.isInteger(e.target.valueAsNumber) && setSeed(stepIndex, e.target.valueAsNumber)}
            />
            <button type="button" title="Reroll" onClick={() => setSeed(stepIndex, randomSeed())}>
              🎲
            </button>
          </span>
        </label>
      </details>
    </aside>
  );
}
