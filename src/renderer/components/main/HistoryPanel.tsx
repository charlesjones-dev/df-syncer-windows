import { useEffect, useState } from 'react';
import type { SyncHistoryEntry } from '@shared/types';
import { api } from '../../api';
import { formatBytes, formatRelative } from './format';

/**
 * HistoryPanel — collapsible drawer listing the last 50 sync history
 * entries. Each row offers an "Open Backup" button that invokes
 * `api.history.openBackupFolder(timestamp)`.
 *
 * The parent passes `version` — when it changes (e.g. after an apply),
 * the panel re-fetches the list.
 */

const MAX_ENTRIES = 50;

export type HistoryPanelProps = {
  /** Bumped by parent after each apply to trigger a refresh. */
  version: number;
  /** Parent surfaces toasts; we delegate openBackupFolder failures to it. */
  onError?: (message: string) => void;
};

export function HistoryPanel(props: HistoryPanelProps): JSX.Element {
  const [entries, setEntries] = useState<SyncHistoryEntry[]>([]);
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await api.history.list();
        if (!cancelled) setEntries(list.slice(0, MAX_ENTRIES));
      } catch {
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.version]);

  const openBackup = async (timestamp: string): Promise<void> => {
    try {
      await api.history.openBackupFolder(timestamp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (props.onError) props.onError(`Couldn't open backup: ${msg}`);
    }
  };

  return (
    <section className="history-panel" aria-labelledby="history-panel-heading">
      <header className="history-panel__header">
        <button
          type="button"
          className="history-panel__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="history-panel-body"
          data-testid="history-panel-toggle"
        >
          <span className="history-panel__chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <h2 id="history-panel-heading" className="history-panel__title">
            History
          </h2>
          <span className="history-panel__count">
            {entries.length === 0
              ? '(empty)'
              : `(${entries.length}${entries.length === MAX_ENTRIES ? '+' : ''})`}
          </span>
        </button>
      </header>
      {open && (
        <div
          className="history-panel__body"
          id="history-panel-body"
          data-testid="history-panel-body"
        >
          {loading && (
            <p className="history-panel__status" role="status">
              Loading history…
            </p>
          )}
          {!loading && entries.length === 0 && (
            <p className="history-panel__empty" data-testid="history-panel-empty">
              No syncs yet.
            </p>
          )}
          {!loading && entries.length > 0 && (
            <ul className="history-panel__list">
              {entries.map((entry) => (
                <HistoryRow
                  key={entry.timestamp}
                  entry={entry}
                  onOpenBackup={() => void openBackup(entry.timestamp)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function HistoryRow(props: { entry: SyncHistoryEntry; onOpenBackup: () => void }): JSX.Element {
  const { entry } = props;
  const result = entry.result;
  const ok = result.ok;
  const ts = new Date(result.completedAt).getTime();
  const relative = formatRelative(ts);
  const fileWord = result.applied === 1 ? 'file' : 'files';
  const summary = ok
    ? `${capitalize(result.direction)} ${result.applied} ${fileWord}, ${formatBytes(result.bytesWritten)}`
    : `${capitalize(result.direction)} failed (${result.errorKind ?? 'error'})`;

  const hasBackup = Boolean(
    result.backupTimestamp || result.backupArchivePath || result.backupDirPath
  );

  return (
    <li
      className={`history-panel__row history-panel__row--${ok ? 'ok' : 'fail'}`}
      data-testid="history-panel-row"
    >
      <span
        className={`history-panel__icon history-panel__icon--${ok ? 'ok' : 'fail'}`}
        aria-hidden="true"
      >
        {ok ? '✓' : '✗'}
      </span>
      <div className="history-panel__row-text">
        <span className="history-panel__row-time" title={result.completedAt}>
          {relative}
        </span>
        <span className="history-panel__row-summary">{summary}</span>
      </div>
      <button
        type="button"
        className="history-panel__row-btn"
        onClick={props.onOpenBackup}
        disabled={!hasBackup}
        title={hasBackup ? 'Open backup folder' : 'No backup recorded'}
        data-testid="history-panel-open-backup"
      >
        Open Backup
      </button>
    </li>
  );
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
