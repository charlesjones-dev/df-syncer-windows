import { useEffect, useState } from 'react';
import type { AppConfig, CloudFolderValidation, DfState, SyncHistoryEntry } from '@shared/types';
import { api } from '../../api';
import { ProcessStatusBadge } from './ProcessStatusBadge';
import { formatBytes, formatRelative } from './format';

/**
 * Header — top status row of the dashboard.
 *
 * Renders three groups:
 *  - Process state badge (Phase 10 wires the real source).
 *  - Cloud folder summary: tail of the path + free GB.
 *  - Last-sync info derived from `api.history.list()` first entry.
 *
 * Refreshing:
 *  - The cloud-folder validation runs once on mount (we re-read it any
 *    time the parent passes a new `cloudFolder` value via the config).
 *  - Last-sync re-queries when `historyVersion` changes — the parent
 *    bumps that counter after a successful apply.
 */

export type HeaderProps = {
  config: AppConfig | null;
  /** Bumped by parent after a successful apply to force history refresh. */
  historyVersion: number;
  /** Phase 10 may inject a known state; otherwise we self-poll/sub. */
  dfState?: DfState | null;
  /** Optional gear-click handler. */
  onOpenSettings?: () => void;
};

function pathTail(p: string, segments = 2): string {
  if (!p) return '';
  // Split on either Windows or POSIX separators.
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= segments) return p;
  return '…\\' + parts.slice(-segments).join('\\');
}

export function Header(props: HeaderProps): JSX.Element {
  const cloudFolder = props.config?.cloudFolder ?? '';
  const [cloudValidation, setCloudValidation] = useState<CloudFolderValidation | null>(null);
  const [lastSync, setLastSync] = useState<SyncHistoryEntry | null>(null);

  // Refresh cloud-folder validation on cloud-folder change.
  useEffect(() => {
    if (!cloudFolder) {
      setCloudValidation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const v = await api.paths.validateCloudFolder(cloudFolder);
        if (!cancelled) setCloudValidation(v);
      } catch {
        if (!cancelled) setCloudValidation(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudFolder]);

  // Refresh last-sync entry when historyVersion ticks.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entries = await api.history.list();
        if (!cancelled) setLastSync(entries[0] ?? null);
      } catch {
        if (!cancelled) setLastSync(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.historyVersion]);

  const cloudSummary = cloudFolder
    ? cloudValidation?.freeBytes !== undefined
      ? `${pathTail(cloudFolder)} (free ${formatBytes(cloudValidation.freeBytes)})`
      : pathTail(cloudFolder)
    : '(cloud folder not set)';

  const lastSyncSummary = formatLastSync(lastSync);

  return (
    <header className="dashboard__header" data-testid="dashboard-header">
      <div className="dashboard__header-row dashboard__header-row--top">
        <h1 className="dashboard__title">df-syncer-windows</h1>
        <button
          type="button"
          className="dashboard__settings-btn"
          aria-label="Open settings"
          onClick={props.onOpenSettings}
          data-testid="dashboard-settings-btn"
        >
          <span aria-hidden="true">⚙</span>
          <span>Settings</span>
        </button>
      </div>
      <div className="dashboard__header-row dashboard__header-row--info">
        <ProcessStatusBadge state={props.dfState} />
        <div className="dashboard__cloud-summary" data-testid="dashboard-cloud-summary">
          <span className="dashboard__label">Cloud:</span>
          <span className="dashboard__cloud-path" title={cloudFolder || undefined}>
            {cloudSummary}
          </span>
        </div>
        <div className="dashboard__last-sync" data-testid="dashboard-last-sync">
          <span className="dashboard__label">Last sync:</span>
          <span className="dashboard__last-sync-text">{lastSyncSummary}</span>
        </div>
      </div>
    </header>
  );
}

function formatLastSync(entry: SyncHistoryEntry | null): string {
  if (!entry) return 'never';
  const result = entry.result;
  const when = formatRelative(new Date(result.completedAt).getTime());
  const direction = result.direction;
  if (!result.ok) {
    return `${when} — ${direction} failed (${result.errorKind ?? 'error'})`;
  }
  const fileWord = result.applied === 1 ? 'file' : 'files';
  return `${when} — ${direction}, ${result.applied} ${fileWord} (${formatBytes(result.bytesWritten)})`;
}
