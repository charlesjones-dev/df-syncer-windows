import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  INITIAL_WIZARD_STATE,
  WIZARD_STEP_COUNT,
  WIZARD_STEP_LABELS,
  canAdvance,
  wizardReducer
} from '../../state/store';
import { api } from '../../api';
import { Step1Welcome } from './Step1Welcome';
import { Step2CloudFolder } from './Step2CloudFolder';
import { Step3GameFolder } from './Step3GameFolder';
import { Step4SyncSelection } from './Step4SyncSelection';
import { Step5MachineIdentity } from './Step5MachineIdentity';
import { Step6Behavior } from './Step6Behavior';
import { Step7ReviewAndDryRun } from './Step7ReviewAndDryRun';

/**
 * The wizard chrome.
 *
 * Owns the reducer (`wizardReducer`), renders the active step, and
 * exposes Back/Next/Cancel/Finish in the footer. Cancel and ESC both
 * prompt with `confirm("Discard setup?")` before exiting.
 *
 * Phase 8: the last-step Next is intercepted by `finish()`, which
 * persists the draft via `api.config.save({ ...draft, firstRunCompleted:
 * true })`, applies the "Start with Windows" toggle via
 * `api.app.setStartWithWindows(...)`, and then calls `props.onExit()` so
 * the renderer routes to the dashboard placeholder.
 */
export type WizardShellProps = {
  /** Called when the user confirms Cancel or finishes the wizard. */
  onExit: () => void;
};

export function WizardShell(props: WizardShellProps): JSX.Element {
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE);
  const stepContainerRef = useRef<HTMLDivElement>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const finish = useCallback(async (): Promise<void> => {
    if (finishing) return;
    setFinishing(true);
    setFinishError(null);
    try {
      const patch = { ...state.draft, firstRunCompleted: true };
      await api.config.save(patch);
      // Apply login-item settings if the user opted in. We pass through
      // both flags; main-side handler tolerates absent `app.setLoginItemSettings`.
      try {
        await api.app.setStartWithWindows({
          openAtLogin: Boolean(state.draft.startWithWindows),
          openAsHidden: Boolean(state.draft.startMinimizedToTray)
        });
      } catch {
        // Non-fatal: don't block Finish on a login-item failure.
      }
      props.onExit();
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinishing(false);
    }
  }, [finishing, props, state.draft]);

  const advance = useCallback(() => {
    if (!canAdvance(state)) return;
    if (state.stepIndex === WIZARD_STEP_COUNT - 1) {
      // Last step: Phase 8 wires the real Finish path.
      void finish();
      return;
    }
    dispatch({ type: 'next' });
  }, [finish, state]);

  const goBack = useCallback(() => {
    if (state.stepIndex > 0) dispatch({ type: 'back' });
  }, [state.stepIndex]);

  const cancel = useCallback(() => {
    const confirmed = window.confirm('Discard setup?');
    if (confirmed) props.onExit();
  }, [props]);

  // Focus the first interactive element of the new step when stepIndex
  // changes. Steps mount their own auto-focus where appropriate; this
  // is the safety net for steps that don't.
  useEffect(() => {
    const root = stepContainerRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    const target = focusables[0];
    if (target && document.activeElement !== target) {
      const active = document.activeElement;
      if (!active || !root.contains(active) || active === document.body) {
        target.focus();
      }
    }
  }, [state.stepIndex]);

  // Keyboard handling: ESC = cancel-with-confirm; Enter = advance when
  // Next is enabled and focus is not inside a textarea / button.
  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
        return;
      }
      if (ev.key === 'Enter') {
        const target = ev.target as HTMLElement | null;
        const tag = target?.tagName ?? '';
        if (tag === 'TEXTAREA') return;
        if (tag === 'BUTTON') return;
        if (tag === 'A') return;
        if (tag === 'INPUT') {
          const inputType = (target as HTMLInputElement).type;
          // Allow Enter to advance from text fields, but never from
          // checkboxes/radios where Enter has its own native behavior.
          if (inputType === 'checkbox' || inputType === 'radio') return;
        }
        if (canAdvance(state)) {
          ev.preventDefault();
          advance();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, cancel, state]);

  const stepIndex = state.stepIndex;
  const stepNumber = stepIndex + 1;
  const stepLabel = WIZARD_STEP_LABELS[stepIndex] ?? '';
  const nextEnabled = canAdvance(state) && !finishing;
  const isLastStep = stepIndex === WIZARD_STEP_COUNT - 1;

  return (
    <div className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <header className="wizard__header">
        <h1 id="wizard-title" className="wizard__title">
          df-syncer-windows setup
        </h1>
        <p
          className="wizard__step-indicator"
          data-testid="wizard-step-indicator"
          aria-live="polite"
        >
          Step {stepNumber} of {WIZARD_STEP_COUNT} &mdash; {stepLabel}
        </p>
        <ol className="wizard__step-list" aria-label="All wizard steps">
          {WIZARD_STEP_LABELS.map((label, i) => {
            const className = [
              'wizard__step-pill',
              i === stepIndex ? 'wizard__step-pill--active' : '',
              i < stepIndex ? 'wizard__step-pill--done' : ''
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <li
                key={label}
                className={className}
                aria-current={i === stepIndex ? 'step' : undefined}
              >
                <span className="wizard__step-pill-num">{i + 1}</span>
                <span className="wizard__step-pill-label">{label}</span>
              </li>
            );
          })}
        </ol>
      </header>

      <div className="wizard__body" ref={stepContainerRef}>
        {stepIndex === 0 && <Step1Welcome onNext={advance} />}
        {stepIndex === 1 && (
          <Step2CloudFolder
            snapshot={state.cloudValidation}
            onPick={(cloudFolder, validation) =>
              dispatch({ type: 'setStep2', cloudFolder, validation })
            }
            onAcceptSoftWarn={() => dispatch({ type: 'acceptStep2SoftWarn' })}
          />
        )}
        {stepIndex === 2 && (
          <Step3GameFolder
            gameFolder={state.draft.gameFolder}
            source={state.gameFolderSource}
            onChange={(gameFolder, source) => dispatch({ type: 'setStep3', gameFolder, source })}
          />
        )}
        {stepIndex === 3 && (
          <Step4SyncSelection
            gameFolder={state.draft.gameFolder ?? ''}
            enabledFolders={state.draft.enabledFolders}
            excludeGlobs={state.draft.excludeGlobs}
            onChange={(payload) => dispatch({ type: 'setStep4', payload })}
          />
        )}
        {stepIndex === 4 && (
          <Step5MachineIdentity
            machineId={state.draft.machineId}
            onChange={(payload) => dispatch({ type: 'setStep5', payload })}
          />
        )}
        {stepIndex === 5 && (
          <Step6Behavior
            conflictPolicy={state.draft.conflictPolicy}
            backup={state.draft.backup}
            monitor={state.draft.monitor}
            startWithWindows={state.draft.startWithWindows}
            startMinimizedToTray={state.draft.startMinimizedToTray}
            onChange={(payload) => dispatch({ type: 'setStep6', payload })}
          />
        )}
        {stepIndex === 6 && <Step7ReviewAndDryRun draft={state.draft} />}
      </div>

      {finishError && (
        <p
          className="wizard-step__error wizard__finish-error"
          role="alert"
          data-testid="wizard-finish-error"
        >
          Couldn&rsquo;t save: {finishError}
        </p>
      )}

      <footer className="wizard__footer">
        <button
          type="button"
          className="wizard__btn wizard__btn--ghost"
          onClick={cancel}
          data-testid="wizard-cancel"
          disabled={finishing}
        >
          Cancel
        </button>
        <div className="wizard__footer-spacer" />
        <button
          type="button"
          className="wizard__btn wizard__btn--secondary"
          onClick={goBack}
          disabled={stepIndex === 0 || finishing}
          data-testid="wizard-back"
        >
          Back
        </button>
        <button
          type="button"
          className="wizard__btn wizard__btn--primary"
          onClick={advance}
          disabled={!nextEnabled}
          data-testid="wizard-next"
        >
          {isLastStep ? (finishing ? 'Saving…' : 'Finish') : 'Next'}
        </button>
      </footer>
    </div>
  );
}
