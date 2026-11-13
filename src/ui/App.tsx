import { useStore } from '../store/store';
import { Editor } from './Editor';
import { SourcePanel } from './SourcePanel';
import { StepPanel } from './StepPanel';
import { TopBar } from './TopBar';

export function App() {
  const warnings = useStore((s) => s.warnings);
  const dismissWarnings = useStore((s) => s.dismissWarnings);

  return (
    <div className="app">
      <TopBar />
      {warnings.length > 0 && (
        <div className="warnings">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <button type="button" onClick={dismissWarnings}>
            Dismiss
          </button>
        </div>
      )}
      <div className="workspace">
        <SourcePanel />
        <Editor stepIndex={0} />
        <StepPanel stepIndex={0} />
      </div>
    </div>
  );
}
