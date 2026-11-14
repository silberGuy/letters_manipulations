import { Fragment, type ReactNode } from 'react';
import { getManipulation, MANIPULATIONS } from '../manipulations';
import { useStore } from '../store/store';

/**
 * A control that shows `children` and opens the Manipulation picker on click.
 * Uses a transparent native <select> on top, so the list isn't clipped by the
 * scrolling tab strip.
 */
function ManipulationPicker({ className, title, onPick, children }: {
  className: string;
  title: string;
  onPick(id: string): void;
  children: ReactNode;
}) {
  return (
    <label className={`picker ${className}`} title={title}>
      {children}
      <select
        value=""
        aria-label={title}
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
      >
        <option value="" disabled>
          {title}
        </option>
        {MANIPULATIONS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1 3h10M4 3V1h4v2M2.5 3l.75 8h5.5l.75-8M5 5v4M7 5v4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** One tab per Step, in order, with arrows between them. */
export function StepTabs() {
  const steps = useStore((s) => s.recipe.steps);
  const selected = useStore((s) => s.selectedStep);
  const { selectStep, addStep, removeStep } = useStore.getState();

  return (
    <nav className="step-tabs">
      {steps.map((step, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <ManipulationPicker className="step-arrow" title="Insert a step here" onPick={(id) => addStep(i, id)}>
              <span className="step-arrow-idle">→</span>
              <span className="step-arrow-hover">+</span>
            </ManipulationPicker>
          )}
          <div className={`step-tab${i === selected ? ' selected' : ''}`}>
            <button type="button" className="step-tab-name" onClick={() => selectStep(i)}>
              {getManipulation(step.manipulationId).label}
            </button>
            {steps.length > 1 && (
              <button type="button" className="step-tab-delete" title="Delete step" onClick={() => removeStep(i)}>
                <TrashIcon />
              </button>
            )}
          </div>
        </Fragment>
      ))}
      <ManipulationPicker className="step-add btn btn-outline" title="Add a step" onPick={(id) => addStep(steps.length, id)}>
        +
      </ManipulationPicker>
    </nav>
  );
}
