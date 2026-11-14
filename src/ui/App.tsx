import { useStore } from '../store/store';
import { Editor } from './Editor';
import { SourcePanel } from './SourcePanel';
import { StepPanel } from './StepPanel';
import { FileActions } from './FileActions';
import { StepTabs } from './StepTabs';

export function App() {
  const warnings = useStore((s) => s.warnings);
  const dismissWarnings = useStore((s) => s.dismissWarnings);
  const selectedStep = useStore((s) => s.selectedStep);

  return (
    <div className="app">
      <div className="sidebar border-right">
        <SourcePanel />
        <FileActions />
      </div>
      <div className="main-column">
        {warnings.length > 0 && (
          <div className="warnings">
            {warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
            <button type="button" className="btn" onClick={dismissWarnings}>
              Dismiss
            </button>
          </div>
        )}
        <Editor stepIndex={selectedStep} />
        <div className="stepbar">
          <StepTabs />
        </div>
      </div>
      <StepPanel stepIndex={selectedStep} />
    </div>
  );
}
