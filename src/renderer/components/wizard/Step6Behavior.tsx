import { useEffect } from 'react';
import type { Step6Payload } from '../../state/store';
import type { AppConfig } from '@shared/types';

/**
 * Step 6 — Behavior.
 *
 * Per spec §8 / §5.1 / §6.5:
 *  - Conflict policy radio (default `newer-wins-backup`).
 *  - Backup retention slider 1-30 (default 10) + compress toggle (default ON).
 *  - Process monitor toggle (default ON).
 *  - On-game-start dropdown (default `prompt-pull`).
 *  - On-game-exit dropdown (default `prompt-push`).
 *  - Start with Windows + Start minimized to tray toggles (both default OFF).
 *
 * The component owns no state of its own — every change re-dispatches
 * the full Step 6 payload to the parent reducer, which performs a
 * shallow merge into the wizard draft.
 */
export type Step6BehaviorProps = {
  conflictPolicy: AppConfig['conflictPolicy'] | undefined;
  backup: AppConfig['backup'] | undefined;
  monitor: AppConfig['monitor'] | undefined;
  startWithWindows: boolean | undefined;
  startMinimizedToTray: boolean | undefined;
  onChange: (payload: Step6Payload) => void;
};

const DEFAULT_PAYLOAD: Step6Payload = {
  conflictPolicy: 'newer-wins-backup',
  backup: { keepLastN: 10, compress: true },
  monitor: {
    enabled: true,
    onGameStart: 'prompt-pull',
    onGameExit: 'prompt-push',
    pollIntervalMs: 3000
  },
  startWithWindows: false,
  startMinimizedToTray: false
};

export function Step6Behavior(props: Step6BehaviorProps): JSX.Element {
  // Resolve the current draft against defaults for rendering. The
  // parent reducer holds the source of truth; on first mount we
  // dispatch defaults so subsequent reads match.
  const conflictPolicy = props.conflictPolicy ?? DEFAULT_PAYLOAD.conflictPolicy;
  const backup = props.backup ?? DEFAULT_PAYLOAD.backup;
  const monitor = props.monitor ?? DEFAULT_PAYLOAD.monitor;
  const startWithWindows = props.startWithWindows ?? DEFAULT_PAYLOAD.startWithWindows;
  const startMinimizedToTray = props.startMinimizedToTray ?? DEFAULT_PAYLOAD.startMinimizedToTray;

  // Seed defaults once when the parent has nothing to render from.
  useEffect(() => {
    if (
      props.conflictPolicy === undefined ||
      props.backup === undefined ||
      props.monitor === undefined ||
      props.startWithWindows === undefined ||
      props.startMinimizedToTray === undefined
    ) {
      props.onChange({
        conflictPolicy,
        backup,
        monitor,
        startWithWindows,
        startMinimizedToTray
      });
    }
    // Run once on mount.
  }, []);

  function update(patch: Partial<Step6Payload>): void {
    props.onChange({
      conflictPolicy,
      backup,
      monitor,
      startWithWindows,
      startMinimizedToTray,
      ...patch
    });
  }

  return (
    <section className="wizard-step wizard-step--behavior" aria-labelledby="step6-heading">
      <h2 id="step6-heading" className="wizard-step__heading">
        How should sync behave?
      </h2>
      <p className="wizard-step__copy">
        Conflict resolution, backups, and what to do when Dwarf Fortress starts and stops.
      </p>

      <fieldset className="step6__fieldset">
        <legend className="step6__legend">When the same file changes on both PCs</legend>
        <ConflictPolicyRadio
          value={conflictPolicy}
          onChange={(v) => update({ conflictPolicy: v })}
        />
      </fieldset>

      <fieldset className="step6__fieldset">
        <legend className="step6__legend">Backups</legend>
        <div className="step6__row">
          <label htmlFor="step6-keep" className="step6__label">
            Keep the last <strong data-testid="step6-keep-value">{backup.keepLastN}</strong> backups
          </label>
          <input
            id="step6-keep"
            type="range"
            min={1}
            max={30}
            step={1}
            value={backup.keepLastN}
            onChange={(ev) => update({ backup: { ...backup, keepLastN: Number(ev.target.value) } })}
            data-testid="step6-keep-slider"
          />
          <span className="step6__range-bounds" aria-hidden="true">
            <span>1</span>
            <span>30</span>
          </span>
        </div>
        <div className="step6__row step6__row--toggle">
          <input
            id="step6-compress"
            type="checkbox"
            checked={backup.compress}
            onChange={(ev) => update({ backup: { ...backup, compress: ev.target.checked } })}
            data-testid="step6-compress"
          />
          <label htmlFor="step6-compress" className="step6__toggle-label">
            Compress backups (.tar.gz)
          </label>
        </div>
      </fieldset>

      <fieldset className="step6__fieldset">
        <legend className="step6__legend">Process monitor</legend>
        <div className="step6__row step6__row--toggle">
          <input
            id="step6-monitor"
            type="checkbox"
            checked={monitor.enabled}
            onChange={(ev) => update({ monitor: { ...monitor, enabled: ev.target.checked } })}
            data-testid="step6-monitor"
          />
          <label htmlFor="step6-monitor" className="step6__toggle-label">
            Watch for Dwarf Fortress starts and stops
          </label>
        </div>
        <div className="step6__row">
          <label htmlFor="step6-on-start" className="step6__label">
            When DF starts
          </label>
          <select
            id="step6-on-start"
            className="step6__select"
            disabled={!monitor.enabled}
            value={monitor.onGameStart}
            onChange={(ev) =>
              update({
                monitor: {
                  ...monitor,
                  onGameStart: ev.target.value as typeof monitor.onGameStart
                }
              })
            }
            data-testid="step6-on-start"
          >
            <option value="do-nothing">Do nothing</option>
            <option value="prompt-pull">Prompt me to pull</option>
            <option value="auto-pull">Auto-pull</option>
          </select>
        </div>
        <div className="step6__row">
          <label htmlFor="step6-on-exit" className="step6__label">
            When DF exits
          </label>
          <select
            id="step6-on-exit"
            className="step6__select"
            disabled={!monitor.enabled}
            value={monitor.onGameExit}
            onChange={(ev) =>
              update({
                monitor: {
                  ...monitor,
                  onGameExit: ev.target.value as typeof monitor.onGameExit
                }
              })
            }
            data-testid="step6-on-exit"
          >
            <option value="do-nothing">Do nothing</option>
            <option value="prompt-push">Prompt me to push</option>
            <option value="auto-push">Auto-push</option>
          </select>
        </div>
      </fieldset>

      <fieldset className="step6__fieldset">
        <legend className="step6__legend">Startup</legend>
        <div className="step6__row step6__row--toggle">
          <input
            id="step6-start-with-windows"
            type="checkbox"
            checked={startWithWindows}
            onChange={(ev) => update({ startWithWindows: ev.target.checked })}
            data-testid="step6-start-with-windows"
          />
          <label htmlFor="step6-start-with-windows" className="step6__toggle-label">
            Start with Windows
          </label>
        </div>
        <div className="step6__row step6__row--toggle">
          <input
            id="step6-start-minimized"
            type="checkbox"
            checked={startMinimizedToTray}
            disabled={!startWithWindows}
            onChange={(ev) => update({ startMinimizedToTray: ev.target.checked })}
            data-testid="step6-start-minimized"
          />
          <label htmlFor="step6-start-minimized" className="step6__toggle-label">
            Start minimized to tray
          </label>
        </div>
      </fieldset>
    </section>
  );
}

type ConflictPolicy = AppConfig['conflictPolicy'];

const POLICY_OPTIONS: ReadonlyArray<{
  value: ConflictPolicy;
  title: string;
  description: string;
}> = [
  {
    value: 'newer-wins-backup',
    title: 'Newer wins, with backup',
    description:
      'The side with the newer timestamp wins; the loser is backed up so it can be recovered.'
  },
  {
    value: 'always-prompt',
    title: 'Always prompt me',
    description: 'df-syncer-windows never decides on your behalf. Every conflict pauses for input.'
  },
  {
    value: 'backup-only-no-resolve',
    title: 'Back up, don’t resolve',
    description: 'Snapshot both sides and skip the conflicting file until you sort it out.'
  }
];

function ConflictPolicyRadio(props: {
  value: ConflictPolicy;
  onChange: (next: ConflictPolicy) => void;
}): JSX.Element {
  return (
    <div className="step6__radio-list" role="radiogroup" aria-labelledby="step6-policy-label">
      <span id="step6-policy-label" className="visually-hidden">
        Conflict policy
      </span>
      {POLICY_OPTIONS.map((opt) => {
        const id = `step6-policy-${opt.value}`;
        const selected = props.value === opt.value;
        return (
          <label
            key={opt.value}
            htmlFor={id}
            className={
              selected ? 'step6__radio-row step6__radio-row--selected' : 'step6__radio-row'
            }
            data-testid={`step6-policy-${opt.value}`}
          >
            <input
              id={id}
              type="radio"
              name="step6-policy"
              value={opt.value}
              checked={selected}
              onChange={() => props.onChange(opt.value)}
            />
            <span className="step6__radio-content">
              <span className="step6__radio-title">{opt.title}</span>
              <span className="step6__radio-desc">{opt.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
