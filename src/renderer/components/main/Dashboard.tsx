import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, DfStateChange, ThemePreference } from '@shared/types';
import { api } from '../../api';
import { Header } from './Header';
import { SyncControls } from './SyncControls';
import { HistoryPanel } from './HistoryPanel';
import { ToastStack, useToasts } from '../shared/Toast';
import { SettingsModal } from './SettingsModal';
import { LogViewer } from './LogViewer';

/**
 * Custom event the in-app prompt banner dispatches to ask SyncControls to
 * trigger a sync in a given direction. Decoupled via the DOM bus so we
 * don't need to refactor SyncControls' internal state into the parent.
 */
export const SYNC_TRIGGER_EVENT = 'df-syncer-windows:trigger-sync';
export type SyncTriggerDetail = { direction: 'pull' | 'push' | 'full' };

/**
 * Dashboard — top-level layout for the post-wizard experience.
 *
 * Owns:
 *  - The persisted `AppConfig` (read once on mount, refreshed when the
 *    settings modal saves).
 *  - Toast notification stack.
 *  - History "version" counter that triggers `<Header/>` and
 *    `<HistoryPanel/>` to re-fetch after each successful apply.
 *  - The Phase 11 settings modal + log viewer drawer + Ctrl+, / Ctrl+L
 *    keyboard handlers (also wired via the application menu).
 *
 * Process state:
 *  - `dfState` is read from `api.process.getDfStatus`/`onStateChange`.
 *    Phase 10's IPC is wired; the `try/catch` is retained for jsdom test
 *    envs where the bridge isn't installed.
 */

export function Dashboard(): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [dfState, setDfState] = useState<DfStateChange | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<'on-start' | 'on-exit' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const { toasts, push, dismiss } = useToasts();

  // Read the persisted config once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.config.get();
        if (!cancelled) setConfig(cfg);
      } catch (err) {
        if (!cancelled) {
          setConfigError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Probe DF state (Phase 10 wired; defensive try/catch for jsdom).
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        const s = await api.process.getDfStatus();
        if (!cancelled) setDfState(s);
      } catch {
        // Bridge not present (test env).
      }
    })();
    try {
      const fn = api.process.onStateChange;
      if (typeof fn === 'function') {
        unsub = fn((s) => {
          if (cancelled) return;
          setDfState(s);
          if (s.prompt === 'on-start' || s.prompt === 'on-exit') {
            setPendingPrompt(s.prompt);
          } else if (!s.running) {
            // DF stopped without a prompt event (e.g. Phase 10's
            // immediate `running:false` before the cooldown). Clear any
            // stale on-start banner so we don't keep showing "DF is
            // running" while it's actually idle.
            setPendingPrompt((p) => (p === 'on-start' ? null : p));
          } else if (s.running) {
            // DF re-started; clear stale on-exit banner.
            setPendingPrompt((p) => (p === 'on-exit' ? null : p));
          }
        });
      }
    } catch {
      // Bridge not present.
    }
    return () => {
      cancelled = true;
      if (unsub) {
        try {
          unsub();
        } catch {
          // Ignore.
        }
      }
    };
  }, []);

  // Phase 11: keyboard shortcuts (Ctrl+, opens Settings, Ctrl+L opens
  // logs). The application menu also fires the same channels via IPC,
  // so even when the renderer doesn't have keyboard focus the Sync menu
  // accelerators continue to work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((o) => !o);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        setLogsOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Phase 11: subscribe to the menu IPC events. Defensive try/catch so
  // jsdom (no preload bridge) doesn't crash the dashboard.
  useEffect(() => {
    let unsubSettings: (() => void) | null = null;
    let unsubLogs: (() => void) | null = null;
    let unsubSync: (() => void) | null = null;
    try {
      const fnS = api.menu?.onSettingsOpen;
      if (typeof fnS === 'function') {
        unsubSettings = fnS(() => setSettingsOpen(true));
      }
    } catch {
      // Bridge not present.
    }
    try {
      const fnL = api.menu?.onLogsOpen;
      if (typeof fnL === 'function') {
        unsubLogs = fnL(() => setLogsOpen(true));
      }
    } catch {
      // Bridge not present.
    }
    try {
      const fnSync = api.menu?.onSyncTrigger;
      if (typeof fnSync === 'function') {
        unsubSync = fnSync((args) => {
          push(
            'info',
            `Use the ${args.dryRun ? 'Dry-Run' : args.direction} button in the dashboard to start.`
          );
        });
      }
    } catch {
      // Bridge not present.
    }
    return () => {
      if (unsubSettings) {
        try {
          unsubSettings();
        } catch {
          // Ignore.
        }
      }
      if (unsubLogs) {
        try {
          unsubLogs();
        } catch {
          // Ignore.
        }
      }
      if (unsubSync) {
        try {
          unsubSync();
        } catch {
          // Ignore.
        }
      }
    };
  }, [push]);

  // Apply theme on config load / change. The default is 'system'; in
  // jsdom there's no `matchMedia` reliable signal so we fall through to
  // the .dashboard root's default dark scheme.
  useEffect(() => {
    if (!config) return;
    applyThemeToRoot(config.theme ?? 'system');
  }, [config]);

  const onApplyDone = useCallback((): void => {
    setHistoryVersion((v) => v + 1);
  }, []);

  const onSettingsSaved = useCallback((next: AppConfig): void => {
    setConfig(next);
  }, []);

  const dfRunning = Boolean(dfState?.running);

  if (configError) {
    return (
      <main className="dashboard dashboard--error">
        <p className="dashboard__error">Failed to load configuration: {configError}</p>
      </main>
    );
  }

  return (
    <main className="dashboard" data-testid="dashboard">
      <Header
        config={config}
        historyVersion={historyVersion}
        dfState={dfState}
        onOpenSettings={(): void => setSettingsOpen(true)}
      />

      <div className="dashboard__body">
        {pendingPrompt && config && (
          <PromptBanner
            kind={pendingPrompt}
            policy={
              pendingPrompt === 'on-start' ? config.monitor.onGameStart : config.monitor.onGameExit
            }
            dfRunning={dfRunning}
            onDismiss={(): void => setPendingPrompt(null)}
            onAction={(direction): void => {
              setPendingPrompt(null);
              window.dispatchEvent(
                new CustomEvent<SyncTriggerDetail>(SYNC_TRIGGER_EVENT, {
                  detail: { direction }
                })
              );
            }}
          />
        )}
        <SyncControls dfRunning={dfRunning} onToast={push} onApplyDone={onApplyDone} />
      </div>

      <div className="dashboard__sidebar">
        <HistoryPanel
          version={historyVersion}
          onError={(msg): void => {
            push('error', msg);
          }}
        />
        <BottomLinks onOpenLogs={(): void => setLogsOpen(true)} />
      </div>

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {settingsOpen && config && (
        <SettingsModal
          config={config}
          onClose={(): void => setSettingsOpen(false)}
          onSaved={onSettingsSaved}
          onToast={push}
        />
      )}

      <LogViewer open={logsOpen} onClose={(): void => setLogsOpen(false)} onToast={push} />
    </main>
  );
}

/* ──────────────────────────── theme ──────────────────────────── */

function applyThemeToRoot(theme: ThemePreference): void {
  const root = document.querySelector('.dashboard');
  if (!root) return;
  root.classList.remove('theme-light', 'theme-dark');
  if (theme === 'light') {
    root.classList.add('theme-light');
    return;
  }
  if (theme === 'dark') {
    root.classList.add('theme-dark');
    return;
  }
  // system: try to detect prefers-color-scheme; default to dark when
  // matchMedia isn't available.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    if (prefersLight) root.classList.add('theme-light');
  }
}

/* ──────────────────────────── prompt banner ──────────────────────────── */

/**
 * In-app fallback for the on-start / on-exit prompts. Renders whenever
 * the process monitor emits `prompt: 'on-start' | 'on-exit'` so the user
 * still gets a clear call-to-action even if Windows toast notifications
 * are silenced (Focus Assist, OS notification settings, missing Start
 * Menu shortcut, etc.). The action button dispatches a custom DOM event
 * `SYNC_TRIGGER_EVENT` that `<SyncControls/>` subscribes to.
 */
function PromptBanner(props: {
  kind: 'on-start' | 'on-exit';
  policy: 'do-nothing' | 'prompt-pull' | 'auto-pull' | 'prompt-push' | 'auto-push';
  dfRunning: boolean;
  onAction: (direction: 'pull' | 'push') => void;
  onDismiss: () => void;
}): JSX.Element | null {
  // If the user disabled prompting for this transition, don't show the
  // banner at all — auto-pull / auto-push runs in the tray and
  // do-nothing means the user explicitly opted out.
  if (
    props.policy === 'do-nothing' ||
    props.policy === 'auto-pull' ||
    props.policy === 'auto-push'
  ) {
    return null;
  }
  const isStart = props.kind === 'on-start';
  const direction: 'pull' | 'push' = isStart ? 'pull' : 'push';
  const title = isStart ? 'Dwarf Fortress is running' : 'Dwarf Fortress closed';
  const body = isStart
    ? 'Pull the latest saves from the cloud before you load a world?'
    : 'Push your latest saves and prefs to the cloud?';
  // For on-start, pulling while DF is mid-load is unsafe — surface the
  // warning the same way the Windows toast does.
  const warning = isStart
    ? 'Pulling now is unsafe if a save is already loaded — close DF first or wait until the menu.'
    : null;
  const buttonDisabled = isStart && props.dfRunning;
  return (
    <aside
      className={`prompt-banner prompt-banner--${props.kind}`}
      role="status"
      aria-live="polite"
      data-testid="prompt-banner"
    >
      <div className="prompt-banner__body">
        <p className="prompt-banner__title">{title}</p>
        <p className="prompt-banner__msg">{body}</p>
        {warning && <p className="prompt-banner__warn">{warning}</p>}
      </div>
      <div className="prompt-banner__actions">
        <button
          type="button"
          className="prompt-banner__btn prompt-banner__btn--primary"
          onClick={(): void => props.onAction(direction)}
          disabled={buttonDisabled}
          title={buttonDisabled ? 'Close DF first to pull safely.' : undefined}
          data-testid="prompt-banner-action"
        >
          {isStart ? 'Pull from cloud' : 'Push to cloud'}
        </button>
        <button
          type="button"
          className="prompt-banner__btn"
          onClick={props.onDismiss}
          data-testid="prompt-banner-dismiss"
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}

/* ──────────────────────────── bottom links ──────────────────────────── */

function BottomLinks(props: { onOpenLogs: () => void }): JSX.Element {
  return (
    <nav className="dashboard__bottom-links" aria-label="Quick links">
      <button
        type="button"
        className="dashboard__bottom-link"
        data-testid="dashboard-link-logs"
        onClick={props.onOpenLogs}
      >
        Logs
      </button>
    </nav>
  );
}
