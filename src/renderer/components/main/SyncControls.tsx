import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SyncDirection,
  SyncPlan,
  SyncPlanItem,
  SyncPlanPrompt,
  SyncPlanResult,
  SyncProgress
} from '@shared/types';
import { api } from '../../api';
import { DiffTable } from './DiffTable';
import { SYNC_TRIGGER_EVENT, type SyncTriggerDetail } from './Dashboard';

/**
 * SyncControls — owns the four action buttons (Pull / Push / Full /
 * Dry-Run) plus the resulting plan preview and conflict resolution
 * modal.
 *
 * A `null` `plan` means "no preview yet"; the empty-state copy renders
 * upstairs in `<Dashboard/>`. When a plan is loaded, this component
 * renders `<DiffTable/>` directly underneath.
 *
 * Apply path:
 *  1. User clicks Apply → call `api.sync.apply({ plan, dryRun: false })`.
 *  2. Subscribe to `api.sync.onProgress(cb)` for the duration of the
 *     apply; pass the latest event into DiffTable for the progress bar.
 *  3. On success, push a success toast via `props.onToast` and clear
 *     the plan; bump `props.onApplyDone()` so `<Header/>` re-reads
 *     `api.history.list()`.
 *  4. On error, push an error toast and leave the plan visible so the
 *     user can retry.
 */

export type SyncControlsProps = {
  /** True while DF is running — disables all buttons with a tooltip. */
  dfRunning: boolean;
  /** Push a notification toast. */
  onToast: (variant: 'success' | 'error' | 'info', message: string) => void;
  /** Called after a successful apply so the dashboard can refresh history. */
  onApplyDone: () => void;
};

type ButtonId = 'pull' | 'push' | 'full' | 'dryrun';

const BUTTON_DEFS: { id: ButtonId; label: string; direction: SyncDirection; dryRun: boolean }[] = [
  { id: 'pull', label: 'Pull', direction: 'pull', dryRun: false },
  { id: 'push', label: 'Push', direction: 'push', dryRun: false },
  { id: 'full', label: 'Full Sync', direction: 'full', dryRun: false },
  { id: 'dryrun', label: 'Dry-Run', direction: 'full', dryRun: true }
];

type LoadedPlan = {
  result: SyncPlanResult;
  mode: 'preview' | 'dryrun';
};

export function SyncControls(props: SyncControlsProps): JSX.Element {
  const [planning, setPlanning] = useState<ButtonId | null>(null);
  const [loaded, setLoaded] = useState<LoadedPlan | null>(null);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [conflictPrompts, setConflictPrompts] = useState<SyncPlanPrompt[] | null>(null);

  const progressBufferRef = useRef<SyncProgress | null>(null);
  const progressFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushProgress = useCallback((): void => {
    const p = progressBufferRef.current;
    progressBufferRef.current = null;
    progressFlushRef.current = null;
    if (p) setProgress(p);
  }, []);

  const queueProgress = useCallback(
    (p: SyncProgress): void => {
      // Throttle UI updates to ~10 Hz so a 1k-item apply doesn't flood
      // React with re-renders.
      progressBufferRef.current = p;
      if (progressFlushRef.current === null) {
        progressFlushRef.current = setTimeout(flushProgress, 100);
      }
    },
    [flushProgress]
  );

  // Subscribe to progress events while applying.
  useEffect(() => {
    if (!applying) return;
    const unsub = api.sync.onProgress(queueProgress);
    return () => {
      unsub();
      if (progressFlushRef.current !== null) {
        clearTimeout(progressFlushRef.current);
        progressFlushRef.current = null;
      }
    };
  }, [applying, queueProgress]);

  // Listen for the in-app prompt banner asking us to start a sync.
  // Decoupled via a custom DOM event so the banner doesn't need to know
  // about our internal state.
  useEffect(() => {
    const handler = (evt: Event): void => {
      const detail = (evt as CustomEvent<SyncTriggerDetail>).detail;
      if (!detail) return;
      const def = BUTTON_DEFS.find((d) => d.direction === detail.direction && !d.dryRun);
      if (!def) return;
      void runPlan(def);
    };
    window.addEventListener(SYNC_TRIGGER_EVENT, handler);
    return () => {
      window.removeEventListener(SYNC_TRIGGER_EVENT, handler);
    };
  }, [planning, applying, props.dfRunning]);

  const runPlan = useCallback(
    async (def: (typeof BUTTON_DEFS)[number]): Promise<void> => {
      if (props.dfRunning || planning || applying) return;
      setPlanning(def.id);
      setLoaded(null);
      setConflictPrompts(null);
      try {
        const res = await api.sync.plan({ direction: def.direction, dryRun: def.dryRun });
        if (res.prompts.length > 0 && !def.dryRun) {
          // Surface conflict prompts inline before showing the table.
          setConflictPrompts(res.prompts);
          setLoaded({ result: res, mode: 'preview' });
        } else {
          setLoaded({ result: res, mode: def.dryRun ? 'dryrun' : 'preview' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        props.onToast('error', `Plan failed: ${msg}`);
      } finally {
        setPlanning(null);
      }
    },
    [applying, planning, props]
  );

  const apply = useCallback(async (): Promise<void> => {
    if (!loaded || loaded.mode !== 'preview' || applying) return;
    if (loaded.result.prompts.length > 0) return;

    setApplying(true);
    setProgress(null);
    try {
      const result = await api.sync.apply({ plan: loaded.result.plan, dryRun: false });
      if (result.ok) {
        const fileWord = result.applied === 1 ? 'file' : 'files';
        props.onToast(
          'success',
          `Sync completed — ${result.applied} ${fileWord} (${result.bytesWritten} bytes)`
        );
        setLoaded(null);
        setConflictPrompts(null);
        props.onApplyDone();
      } else {
        props.onToast('error', `Sync failed: ${result.error ?? result.errorKind ?? 'unknown'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      props.onToast('error', `Sync error: ${msg}`);
    } finally {
      setApplying(false);
      setProgress(null);
    }
  }, [applying, loaded, props]);

  const abort = useCallback(async (): Promise<void> => {
    if (!applying) return;
    try {
      await api.sync.cancel();
      props.onToast('info', 'Sync cancellation requested.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      props.onToast('error', `Cancel failed: ${msg}`);
    }
  }, [applying, props]);

  const cancelPlan = useCallback((): void => {
    setLoaded(null);
    setConflictPrompts(null);
  }, []);

  // Resolve conflicts: rewrite each prompt as a concrete plan item, then
  // close the modal and return to the preview view.
  const resolveConflicts = useCallback(
    (choices: Map<string, ConflictChoice>): void => {
      if (!loaded) return;
      const updatedPlan = applyConflictChoices(loaded.result.plan, choices);
      setLoaded({
        result: { plan: updatedPlan, prompts: [] },
        mode: 'preview'
      });
      setConflictPrompts(null);
    },
    [loaded]
  );

  const buttonsDisabled = props.dfRunning || planning !== null || applying;

  return (
    <div className="sync-controls" data-testid="sync-controls">
      <div
        className="sync-controls__buttons"
        role="toolbar"
        aria-label="Sync actions"
        aria-disabled={buttonsDisabled || undefined}
      >
        {BUTTON_DEFS.map((def) => (
          <button
            key={def.id}
            type="button"
            className={`sync-controls__btn sync-controls__btn--${def.id}`}
            onClick={() => void runPlan(def)}
            disabled={buttonsDisabled}
            title={props.dfRunning ? 'Close DF to sync' : undefined}
            aria-busy={planning === def.id}
            data-testid={`sync-btn-${def.id}`}
          >
            {planning === def.id ? 'Planning…' : def.label}
          </button>
        ))}
      </div>

      {conflictPrompts && loaded && (
        <ConflictDialog
          prompts={conflictPrompts}
          onResolve={resolveConflicts}
          onCancel={() => {
            setConflictPrompts(null);
            setLoaded(null);
          }}
        />
      )}

      {loaded && !conflictPrompts && (
        <DiffTable
          plan={loaded.result.plan}
          mode={loaded.mode}
          inProgress={applying}
          progress={progress}
          onApply={apply}
          onCancel={cancelPlan}
          onAbort={abort}
        />
      )}

      {!loaded && !conflictPrompts && (
        <p className="sync-controls__empty" data-testid="sync-controls-empty">
          No plan yet — click an action above.
        </p>
      )}
    </div>
  );
}

/* ──────────────────────────── conflict resolution ──────────────────────────── */

type ConflictChoice = 'keep-local' | 'keep-cloud' | 'keep-both';

type ConflictDialogProps = {
  prompts: SyncPlanPrompt[];
  onResolve: (choices: Map<string, ConflictChoice>) => void;
  onCancel: () => void;
};

function ConflictDialog(props: ConflictDialogProps): JSX.Element {
  const [choices, setChoices] = useState<Map<string, ConflictChoice>>(() => {
    const m = new Map<string, ConflictChoice>();
    for (const p of props.prompts) {
      // Default to "keep-local" if available, else the first option.
      const dflt = p.options.find((o) => o !== 'keep-both') ?? p.options[0];
      m.set(p.rel, dflt);
    }
    return m;
  });

  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the dialog on mount for keyboard users.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // ESC to close.
  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        props.onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const setChoice = (rel: string, choice: ConflictChoice): void => {
    setChoices((prev) => {
      const next = new Map(prev);
      next.set(rel, choice);
      return next;
    });
  };

  const allResolved = props.prompts.every((p) => choices.has(p.rel));

  return (
    <div
      className="conflict-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-dialog-heading"
      tabIndex={-1}
      ref={dialogRef}
      data-testid="conflict-dialog"
    >
      <div className="conflict-dialog__panel">
        <h2 id="conflict-dialog-heading" className="conflict-dialog__heading">
          Resolve {props.prompts.length} conflict{props.prompts.length === 1 ? '' : 's'}
        </h2>
        <p className="conflict-dialog__copy">
          Both sides changed these files. Pick which version wins on each row.
        </p>
        <ul className="conflict-dialog__list">
          {props.prompts.map((p) => (
            <ConflictRow
              key={p.rel}
              prompt={p}
              choice={choices.get(p.rel)}
              onChoose={(c) => setChoice(p.rel, c)}
            />
          ))}
        </ul>
        <footer className="conflict-dialog__footer">
          <button
            type="button"
            className="conflict-dialog__btn"
            onClick={props.onCancel}
            data-testid="conflict-dialog-cancel"
          >
            Cancel
          </button>
          <div className="conflict-dialog__spacer" />
          <button
            type="button"
            className="conflict-dialog__btn conflict-dialog__btn--primary"
            disabled={!allResolved}
            onClick={() => props.onResolve(choices)}
            data-testid="conflict-dialog-resolve"
          >
            Resolve
          </button>
        </footer>
      </div>
    </div>
  );
}

function ConflictRow(props: {
  prompt: SyncPlanPrompt;
  choice: ConflictChoice | undefined;
  onChoose: (c: ConflictChoice) => void;
}): JSX.Element {
  const { prompt } = props;
  const optionLabels: Record<ConflictChoice, string> = {
    'keep-local': 'Keep local',
    'keep-cloud': 'Keep cloud',
    'keep-both': 'Keep both'
  };
  return (
    <li className="conflict-dialog__row" data-testid="conflict-dialog-row" data-rel={prompt.rel}>
      <span className="conflict-dialog__rel" title={prompt.rel}>
        {prompt.rel}
      </span>
      <fieldset className="conflict-dialog__choices">
        <legend className="visually-hidden">Resolution for {prompt.rel}</legend>
        {prompt.options.map((opt) => {
          const disabled = opt === 'keep-both';
          return (
            <label
              key={opt}
              className={`conflict-dialog__choice ${disabled ? 'conflict-dialog__choice--disabled' : ''}`}
              title={disabled ? 'Phase 11' : undefined}
            >
              <input
                type="radio"
                name={`conflict-${prompt.rel}`}
                value={opt}
                checked={props.choice === opt}
                onChange={() => props.onChoose(opt)}
                disabled={disabled}
              />
              <span>{optionLabels[opt]}</span>
            </label>
          );
        })}
      </fieldset>
    </li>
  );
}

/**
 * Rewrite the plan in-place based on user choices.
 *
 * For each conflict item with a corresponding choice:
 *  - `keep-local` → coerce to a `push` item (local wins, cloud will be
 *    overwritten); if local is missing, a `push-delete` is the right
 *    sibling.
 *  - `keep-cloud` → coerce to a `pull` (or `pull-delete`).
 *  - `keep-both` → leave as conflict for now (Phase 11 wires renaming).
 *
 * The executor re-validates server-side that no conflict-kind item
 * survives with `applied: true`, so we set `applied: true` on resolved
 * rows and `applied: false` on `keep-both` rows.
 */
function applyConflictChoices(plan: SyncPlan, choices: Map<string, ConflictChoice>): SyncPlan {
  const items: SyncPlanItem[] = plan.items.map((item) => {
    const choice = choices.get(item.rel);
    if (!choice) return item;
    if (choice === 'keep-both') {
      return { ...item, applied: false };
    }
    return rewriteConflict(item, choice);
  });
  return {
    ...plan,
    items,
    summary: rebuildSummary(items)
  };
}

function rewriteConflict(item: SyncPlanItem, choice: 'keep-local' | 'keep-cloud'): SyncPlanItem {
  // Decide concrete action based on which side exists.
  const hasLocal = item.localEntry !== null;
  const hasCloud = item.cloudEntry !== null;

  if (choice === 'keep-local') {
    if (!hasLocal && hasCloud) {
      return { ...item, kind: 'push-delete', applied: true };
    }
    return { ...item, kind: 'push', applied: true };
  }
  // keep-cloud
  if (!hasCloud && hasLocal) {
    return { ...item, kind: 'pull-delete', applied: true };
  }
  return { ...item, kind: 'pull', applied: true };
}

function rebuildSummary(items: readonly SyncPlanItem[]): SyncPlan['summary'] {
  let pushCount = 0;
  let pullCount = 0;
  let conflictCount = 0;
  let totalBytes = 0;
  for (const it of items) {
    if (it.kind === 'push' || it.kind === 'push-delete') pushCount += 1;
    else if (it.kind === 'pull' || it.kind === 'pull-delete') pullCount += 1;
    else conflictCount += 1;
    if (it.applied) totalBytes += it.bytes;
  }
  return { pushCount, pullCount, conflictCount, totalBytes };
}
