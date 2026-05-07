import { useState } from 'react';
import { api } from '../../api';
import type { AppConfig, DryRunPreview, SyncPlanItem } from '@shared/types';
import type { WizardDraft } from '../../state/store';

/**
 * Step 7 — Review & Dry-Run.
 *
 * Renders a read-only summary grouped by section (cloud + game,
 * folders, identity, behavior). Below it, a "Run dry-run preview"
 * button triggers `api.sync.planDryRun(draft)`. The result is rendered
 * inline as summary counts plus the top-10 plan items so the user can
 * sanity-check what the first real sync would do.
 *
 * If the IPC returns a stub note (engine not yet shipped), the note
 * is surfaced prominently in place of the live preview.
 *
 * The Finish action is owned by the parent (`WizardShell`); this
 * component only signals readiness via `onPreviewReady` so the parent
 * can decide whether to highlight the Finish CTA.
 */
export type Step7ReviewAndDryRunProps = {
  draft: WizardDraft;
};

const ONE_KB = 1024;
const ONE_MB = ONE_KB * 1024;
const ONE_GB = ONE_MB * 1024;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < ONE_KB) return `${bytes} B`;
  if (bytes < ONE_MB) return `${(bytes / ONE_KB).toFixed(1)} KB`;
  if (bytes < ONE_GB) return `${(bytes / ONE_MB).toFixed(1)} MB`;
  return `${(bytes / ONE_GB).toFixed(2)} GB`;
}

type DryRunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; preview: DryRunPreview }
  | { status: 'error'; message: string };

export function Step7ReviewAndDryRun(props: Step7ReviewAndDryRunProps): JSX.Element {
  const [dryRun, setDryRun] = useState<DryRunState>({ status: 'idle' });

  async function runDryRun(): Promise<void> {
    setDryRun({ status: 'running' });
    try {
      // Send the draft as a Partial<AppConfig>; the main side merges
      // with persisted defaults.
      const preview = await api.sync.planDryRun(props.draft as Partial<AppConfig>);
      setDryRun({ status: 'done', preview });
    } catch (err) {
      setDryRun({
        status: 'error',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return (
    <section className="wizard-step wizard-step--review" aria-labelledby="step7-heading">
      <h2 id="step7-heading" className="wizard-step__heading">
        Review and preview
      </h2>
      <p className="wizard-step__copy">
        Here&rsquo;s everything we&rsquo;ll save when you click Finish. Run a dry-run preview to see
        exactly what the first sync would do.
      </p>

      <ReviewSummary draft={props.draft} />

      <div className="step7__dryrun">
        <button
          type="button"
          className="step7__dryrun-btn"
          onClick={runDryRun}
          disabled={dryRun.status === 'running'}
          data-testid="step7-dryrun-btn"
        >
          {dryRun.status === 'running' ? 'Running…' : 'Run dry-run preview'}
        </button>

        {dryRun.status === 'running' && (
          <p className="wizard-step__status" role="status">
            Computing diff against the cloud folder…
          </p>
        )}

        {dryRun.status === 'error' && (
          <p className="wizard-step__error" role="alert" data-testid="step7-dryrun-error">
            Dry-run failed: {dryRun.message}
          </p>
        )}

        {dryRun.status === 'done' && <DryRunResult preview={dryRun.preview} />}
      </div>
    </section>
  );
}

/* ───────────────── review summary ───────────────── */

function ReviewSummary(props: { draft: WizardDraft }): JSX.Element {
  const { draft } = props;
  return (
    <div className="step7__summary" data-testid="step7-summary">
      <Section title="Locations">
        <Row label="Cloud-drive folder" value={draft.cloudFolder ?? '(not set)'} />
        <Row label="Game folder" value={draft.gameFolder ?? '(not set)'} />
      </Section>
      <Section title="Folders to sync">
        <Row
          label="Enabled"
          value={
            draft.enabledFolders
              ? Object.entries(draft.enabledFolders)
                  .filter(([, on]) => on)
                  .map(([k]) => k)
                  .join(', ') || 'none'
              : 'defaults (save, mods, prefs)'
          }
        />
        <Row
          label="Excludes"
          value={
            draft.excludeGlobs && draft.excludeGlobs.length > 0
              ? `${draft.excludeGlobs.length} glob${draft.excludeGlobs.length === 1 ? '' : 's'}`
              : '0 globs'
          }
        />
      </Section>
      <Section title="Identity">
        <Row label="Machine ID" value={draft.machineId ?? '(unset)'} />
      </Section>
      <Section title="Behavior">
        <Row label="Conflict policy" value={draft.conflictPolicy ?? 'newer-wins-backup'} />
        <Row
          label="Backups"
          value={
            draft.backup
              ? `keep last ${draft.backup.keepLastN}${draft.backup.compress ? ', compressed' : ''}`
              : 'keep last 10, compressed'
          }
        />
        <Row
          label="Process monitor"
          value={
            draft.monitor
              ? draft.monitor.enabled
                ? `on (start: ${draft.monitor.onGameStart}, exit: ${draft.monitor.onGameExit})`
                : 'off'
              : 'on (start: prompt-pull, exit: prompt-push)'
          }
        />
        <Row
          label="Start with Windows"
          value={
            draft.startWithWindows
              ? draft.startMinimizedToTray
                ? 'yes (minimized to tray)'
                : 'yes'
              : 'no'
          }
        />
      </Section>
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="step7__section">
      <h3 className="step7__section-title">{props.title}</h3>
      <dl className="step7__rows">{props.children}</dl>
    </div>
  );
}

function Row(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="step7__row">
      <dt className="step7__row-label">{props.label}</dt>
      <dd className="step7__row-value" title={props.value}>
        {props.value}
      </dd>
    </div>
  );
}

/* ───────────────── dry-run result ───────────────── */

function DryRunResult(props: { preview: DryRunPreview }): JSX.Element {
  const { plan, notes } = props.preview;
  const items = plan.items.slice(0, 10);

  return (
    <div className="step7__dryrun-result" data-testid="step7-dryrun-result">
      {notes && (
        <p className="step7__dryrun-note" role="note" data-testid="step7-dryrun-note">
          {notes}
        </p>
      )}

      <ul className="step7__dryrun-summary" aria-label="Preview summary">
        <li data-testid="step7-summary-push">
          <span className="step7__summary-num">{plan.summary.pushCount}</span> push
        </li>
        <li data-testid="step7-summary-pull">
          <span className="step7__summary-num">{plan.summary.pullCount}</span> pull
        </li>
        <li data-testid="step7-summary-conflict">
          <span className="step7__summary-num">{plan.summary.conflictCount}</span> conflict
        </li>
        <li data-testid="step7-summary-bytes">
          <span className="step7__summary-num">{formatBytes(plan.summary.totalBytes)}</span> total
        </li>
      </ul>

      {items.length > 0 && (
        <div className="step7__dryrun-items">
          <p className="step7__dryrun-items-heading">
            First {items.length} of {plan.items.length} item
            {plan.items.length === 1 ? '' : 's'}
          </p>
          <ul className="step7__dryrun-items-list">
            {items.map((item) => (
              <DryRunItem key={item.rel} item={item} />
            ))}
          </ul>
        </div>
      )}

      {plan.items.length === 0 && !notes && (
        <p className="step7__dryrun-empty" data-testid="step7-dryrun-empty">
          Nothing to sync — local and cloud are already in agreement.
        </p>
      )}
    </div>
  );
}

function DryRunItem(props: { item: SyncPlanItem }): JSX.Element {
  const { item } = props;
  const kindLabel = friendlyKind(item.kind);
  return (
    <li className={`step7__item step7__item--${item.kind}`}>
      <span className="step7__item-kind">{kindLabel}</span>
      <span className="step7__item-rel" title={item.rel}>
        {item.rel}
      </span>
      <span className="step7__item-bytes">{formatBytes(item.bytes)}</span>
    </li>
  );
}

function friendlyKind(kind: SyncPlanItem['kind']): string {
  switch (kind) {
    case 'push':
      return 'push';
    case 'pull':
      return 'pull';
    case 'push-delete':
      return 'push delete';
    case 'pull-delete':
      return 'pull delete';
    case 'conflict-newer-local':
      return 'conflict (local newer)';
    case 'conflict-newer-cloud':
      return 'conflict (cloud newer)';
    case 'conflict-tie':
      return 'conflict (tie)';
    case 'conflict-local-deleted':
      return 'conflict (local deleted)';
    case 'conflict-cloud-deleted':
      return 'conflict (cloud deleted)';
    default:
      return kind;
  }
}
