/**
 * LogViewer — Phase 11.
 *
 * Bottom drawer that streams the main-process logger via the
 * `api.logs.tail` subscription. Filter by level, follow toggle (auto-
 * scroll on new lines), copy-to-clipboard, and "Open Logs Folder"
 * shortcut.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, LogLevel } from '@shared/types';
import { api } from '../../api';

export type LogViewerProps = {
  open: boolean;
  onClose: () => void;
  onToast?: (variant: 'success' | 'error' | 'info', message: string) => void;
};

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];
const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

/** Hard cap on lines kept in memory so an open-overnight session doesn't OOM. */
const MAX_BUFFER = 5000;

export function LogViewer(props: LogViewerProps): JSX.Element | null {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LogLevel>('info');
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const subscriptionId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

  // Subscribe on open; clean up on close.
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    let unsubLine: (() => void) | null = null;
    setError(null);

    (async () => {
      try {
        const sub = await api.logs.tail({ fromLines: 200 });
        if (cancelled) {
          // Caller closed before subscription completed — clean up.
          try {
            await api.logs.unsubscribe(sub.id);
          } catch {
            // Ignore.
          }
          return;
        }
        subscriptionId.current = sub.id;
        setEntries(sub.recent);
        unsubLine = api.logs.onLine((subId, entry) => {
          if (subId !== subscriptionId.current) return;
          setEntries((prev) => {
            const next = [...prev, entry];
            if (next.length > MAX_BUFFER) {
              return next.slice(next.length - MAX_BUFFER);
            }
            return next;
          });
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (unsubLine) {
        try {
          unsubLine();
        } catch {
          // Ignore.
        }
      }
      const id = subscriptionId.current;
      subscriptionId.current = null;
      if (id) {
        void api.logs.unsubscribe(id).catch(() => {
          // Ignore.
        });
      }
    };
  }, [props.open]);

  // Auto-scroll to bottom when new lines arrive (if following).
  useEffect(() => {
    if (!followRef.current) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  // ESC closes the drawer.
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [props.open, props]);

  const visible = useMemo(() => {
    const cap = LEVEL_RANK[filter];
    return entries.filter((e) => LEVEL_RANK[e.level] <= cap);
  }, [entries, filter]);

  const onChangeLevel = useCallback(async (level: LogLevel): Promise<void> => {
    setFilter(level);
    try {
      await api.logs.setLevel(level);
    } catch {
      // Best-effort; the renderer keeps the filter even if persistence fails.
    }
  }, []);

  const onCopy = useCallback(async (): Promise<void> => {
    const text = visible.map((e) => formatLine(e)).join('\n');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        props.onToast?.('success', `Copied ${visible.length} log lines.`);
      } else {
        props.onToast?.('info', 'Clipboard not available.');
      }
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    }
  }, [props, visible]);

  const onOpenFolder = useCallback(async (): Promise<void> => {
    try {
      await api.app.openLogsFolder();
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    }
  }, [props]);

  if (!props.open) return null;

  return (
    <aside
      className="log-viewer"
      role="region"
      aria-label="Application logs"
      data-testid="log-viewer"
    >
      <header className="log-viewer__header">
        <h2 className="log-viewer__heading">Logs</h2>
        <label className="log-viewer__filter">
          <span>Level</span>
          <select
            value={filter}
            onChange={(e): void => {
              void onChangeLevel(e.target.value as LogLevel);
            }}
            data-testid="log-viewer-level"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="log-viewer__follow">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e): void => setFollow(e.target.checked)}
            data-testid="log-viewer-follow"
          />
          Follow
        </label>
        <button
          type="button"
          className="log-viewer__btn"
          onClick={(): void => {
            void onCopy();
          }}
          data-testid="log-viewer-copy"
        >
          Copy
        </button>
        <button
          type="button"
          className="log-viewer__btn"
          onClick={(): void => {
            void onOpenFolder();
          }}
          data-testid="log-viewer-open-folder"
        >
          Open Folder
        </button>
        <button
          type="button"
          className="log-viewer__btn log-viewer__btn--close"
          onClick={props.onClose}
          aria-label="Close log viewer"
          data-testid="log-viewer-close"
        >
          ×
        </button>
      </header>

      {error && (
        <p className="log-viewer__error" role="alert" data-testid="log-viewer-error">
          {error}
        </p>
      )}

      <div className="log-viewer__list" ref={listRef} data-testid="log-viewer-list">
        {visible.length === 0 ? (
          <p className="log-viewer__empty">No log entries yet.</p>
        ) : (
          visible.map((e, i) => (
            <div
              key={`${e.ts}-${i}`}
              className={`log-viewer__row log-viewer__row--${e.level}`}
              data-testid={`log-viewer-row-${e.level}`}
            >
              <time className="log-viewer__ts">{formatTs(e.ts)}</time>
              <span className="log-viewer__level">{e.level}</span>
              <span className="log-viewer__msg">{e.message}</span>
              {e.fields && Object.keys(e.fields).length > 0 && (
                <span className="log-viewer__fields">{safeFields(e.fields)}</span>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function formatLine(e: LogEntry): string {
  const fields = e.fields && Object.keys(e.fields).length > 0 ? ` ${safeFields(e.fields)}` : '';
  return `[${e.ts}] [${e.level}] ${e.message}${fields}`;
}

function formatTs(iso: string): string {
  // Render `HH:MM:SS` portion for compactness; the full ISO is still in
  // copy-to-clipboard output.
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

function safeFields(o: Record<string, unknown>): string {
  try {
    return JSON.stringify(o);
  } catch {
    return '[unserialisable]';
  }
}
