/**
 * SettingsModal — Phase 11.
 *
 * Tabbed configuration UI replacing the Phase 9 placeholder modal. Each
 * tab is a small inline component; per-section Save buttons mean the
 * user can persist incremental changes without committing the rest of
 * the form, which mirrors the wizard's per-step gating.
 *
 * Tabs:
 *  - General: machineId, theme, start-with-Windows, minimised-to-tray
 *  - Sync: enabled folders + conflict policy
 *  - Backup: keepLastN + compress
 *  - Monitor: enabled / poll interval / on-start / on-exit policies
 *  - Excludes: textarea of glob lines, validated live via picomatch
 *  - About: version, links, Open Logs / Backups buttons
 *
 * Every input has min/max or pattern validation; invalid values surface
 * inline and disable the section's Save button. ESC closes (with
 * confirm if any section has unsaved changes); focus is trapped inside
 * the modal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import picomatch from 'picomatch';
import type { AppConfig, ConflictPolicy, EnabledFolders, ThemePreference } from '@shared/types';
import { api } from '../../api';
import { DEFAULT_EXCLUDE_GLOBS, isValidMachineId } from '../../state/store';

export type SettingsModalProps = {
  /** The config currently in effect; the modal is preloaded from this. */
  config: AppConfig;
  onClose: () => void;
  /** Called after a successful save; parent should refresh its config. */
  onSaved?: (next: AppConfig) => void;
  /** Push a toast (shared with the dashboard). */
  onToast?: (variant: 'success' | 'error' | 'info', message: string) => void;
};

type TabId = 'general' | 'sync' | 'backup' | 'monitor' | 'excludes' | 'about';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'sync', label: 'Sync' },
  { id: 'backup', label: 'Backup' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'excludes', label: 'Excludes' },
  { id: 'about', label: 'About' }
];

const POLL_INTERVAL_MIN_MS = 500;
const POLL_INTERVAL_MAX_MS = 60_000;
const KEEP_LAST_MIN = 1;
const KEEP_LAST_MAX = 30;

export function SettingsModal(props: SettingsModalProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [dirty, setDirty] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Close handler with unsaved-changes guard.
  const requestClose = useCallback((): void => {
    if (!dirty) {
      props.onClose();
      return;
    }
    const ok =
      typeof window !== 'undefined' && window.confirm
        ? window.confirm('Discard unsaved changes?')
        : true;
    if (ok) props.onClose();
  }, [dirty, props]);

  // ESC closes; Tab cycles within the modal (focus trap).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key === 'Tab') {
        const root = panelRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [requestClose]);

  // Apply theme to the dashboard root immediately so the user sees the
  // change. The persistent config is updated when General is saved.
  const applyTheme = useCallback((theme: ThemePreference): void => {
    const root = document.querySelector('.dashboard');
    if (!root) return;
    root.classList.remove('theme-light', 'theme-dark');
    if (theme === 'light') root.classList.add('theme-light');
    if (theme === 'dark') root.classList.add('theme-dark');
  }, []);

  const onSaved = useCallback(
    (next: AppConfig): void => {
      setDirty(false);
      props.onSaved?.(next);
    },
    [props]
  );

  return (
    <div
      className="settings-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-heading"
      data-testid="settings-modal"
      onClick={(e): void => {
        // Click outside the panel closes (with the same dirty guard).
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="settings-modal__panel settings-modal__panel--tabs" ref={panelRef}>
        <header className="settings-modal__header">
          <h2 id="settings-modal-heading" className="settings-modal__heading">
            Settings
          </h2>
          <button
            type="button"
            className="settings-modal__close"
            onClick={requestClose}
            aria-label="Close settings"
            data-testid="settings-modal-close"
          >
            ×
          </button>
        </header>

        <div className="settings-modal__layout">
          <nav className="settings-modal__tabs" role="tablist" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`settings-tab-${t.id}`}
                aria-selected={activeTab === t.id}
                aria-controls={`settings-panel-${t.id}`}
                className={`settings-modal__tab${activeTab === t.id ? ' settings-modal__tab--active' : ''}`}
                onClick={(): void => setActiveTab(t.id)}
                data-testid={`settings-tab-${t.id}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <section
            className="settings-modal__panel-body"
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
          >
            {activeTab === 'general' && (
              <GeneralTab
                config={props.config}
                onDirty={setDirty}
                onSaved={onSaved}
                onToast={props.onToast}
                onPreviewTheme={applyTheme}
              />
            )}
            {activeTab === 'sync' && (
              <SyncTab
                config={props.config}
                onDirty={setDirty}
                onSaved={onSaved}
                onToast={props.onToast}
              />
            )}
            {activeTab === 'backup' && (
              <BackupTab
                config={props.config}
                onDirty={setDirty}
                onSaved={onSaved}
                onToast={props.onToast}
              />
            )}
            {activeTab === 'monitor' && (
              <MonitorTab
                config={props.config}
                onDirty={setDirty}
                onSaved={onSaved}
                onToast={props.onToast}
              />
            )}
            {activeTab === 'excludes' && (
              <ExcludesTab
                config={props.config}
                onDirty={setDirty}
                onSaved={onSaved}
                onToast={props.onToast}
              />
            )}
            {activeTab === 'about' && <AboutTab onToast={props.onToast} />}
          </section>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────── Tab components ───────────────────── */

type TabProps = {
  config: AppConfig;
  onDirty: (dirty: boolean) => void;
  onSaved: (next: AppConfig) => void;
  onToast?: (variant: 'success' | 'error' | 'info', message: string) => void;
};

/* General */

type GeneralTabProps = TabProps & {
  onPreviewTheme: (t: ThemePreference) => void;
};

function GeneralTab(props: GeneralTabProps): JSX.Element {
  const [machineId, setMachineId] = useState(props.config.machineId);
  const [theme, setTheme] = useState<ThemePreference>(props.config.theme ?? 'system');
  const [startWithWindows, setStartWithWindows] = useState(props.config.startWithWindows);
  const [startMinimizedToTray, setStartMinimizedToTray] = useState(
    props.config.startMinimizedToTray
  );
  const [saving, setSaving] = useState(false);

  const machineIdValid = isValidMachineId(machineId);
  const machineIdError = machineIdValid ? null : 'Use 1–32 chars: letters, digits, . _ -';

  const dirty =
    machineId !== props.config.machineId ||
    theme !== (props.config.theme ?? 'system') ||
    startWithWindows !== props.config.startWithWindows ||
    startMinimizedToTray !== props.config.startMinimizedToTray;

  useEffect(() => {
    props.onDirty(dirty);
  }, [dirty, props]);

  async function onSave(): Promise<void> {
    if (!machineIdValid) return;
    setSaving(true);
    try {
      const next = await api.config.save({
        machineId,
        theme,
        startWithWindows,
        startMinimizedToTray
      });
      try {
        await api.app.setStartWithWindows({
          openAtLogin: startWithWindows,
          openAsHidden: startMinimizedToTray
        });
      } catch {
        // Best-effort; setStartWithWindows can be a no-op in some envs.
      }
      props.onSaved(next);
      props.onToast?.('success', 'General settings saved.');
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="settings-section"
      onSubmit={(e): void => {
        e.preventDefault();
        void onSave();
      }}
    >
      <h3 className="settings-section__heading">General</h3>

      <label className="settings-field">
        <span className="settings-field__label">Machine ID</span>
        <input
          type="text"
          className={`settings-field__input${machineIdError ? ' settings-field__input--invalid' : ''}`}
          value={machineId}
          onChange={(e): void => setMachineId(e.target.value)}
          maxLength={32}
          aria-invalid={!machineIdValid}
          data-testid="settings-machineid-input"
        />
        {machineIdError && (
          <span
            className="settings-field__error"
            role="alert"
            data-testid="settings-machineid-error"
          >
            {machineIdError}
          </span>
        )}
      </label>

      <fieldset className="settings-field">
        <legend className="settings-field__label">Theme</legend>
        {(['system', 'dark', 'light'] as const).map((t) => (
          <label key={t} className="settings-radio">
            <input
              type="radio"
              name="settings-theme"
              value={t}
              checked={theme === t}
              onChange={(): void => {
                setTheme(t);
                props.onPreviewTheme(t);
              }}
              data-testid={`settings-theme-${t}`}
            />
            {t}
          </label>
        ))}
      </fieldset>

      <label className="settings-field settings-field--inline">
        <input
          type="checkbox"
          checked={startWithWindows}
          onChange={(e): void => setStartWithWindows(e.target.checked)}
          data-testid="settings-start-with-windows"
        />
        <span>Start with Windows</span>
      </label>

      <label className="settings-field settings-field--inline">
        <input
          type="checkbox"
          checked={startMinimizedToTray}
          onChange={(e): void => setStartMinimizedToTray(e.target.checked)}
          data-testid="settings-start-minimized"
        />
        <span>Start minimized to tray</span>
      </label>

      <div className="settings-section__footer">
        <button
          type="submit"
          className="settings-btn settings-btn--primary"
          disabled={!dirty || !machineIdValid || saving}
          data-testid="settings-general-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/* Sync */

function SyncTab(props: TabProps): JSX.Element {
  const [cloudFolder, setCloudFolder] = useState(props.config.cloudFolder);
  const [gameFolder, setGameFolder] = useState(props.config.gameFolder);
  const [cloudWarn, setCloudWarn] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [gameError, setGameError] = useState<string | null>(null);
  const [picking, setPicking] = useState<'cloud' | 'game' | null>(null);
  const [enabled, setEnabled] = useState<EnabledFolders>(props.config.enabledFolders);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>(props.config.conflictPolicy);
  const [saving, setSaving] = useState(false);

  const dirty =
    cloudFolder !== props.config.cloudFolder ||
    gameFolder !== props.config.gameFolder ||
    enabled.data !== props.config.enabledFolders.data ||
    enabled.mods !== props.config.enabledFolders.mods ||
    enabled.prefs !== props.config.enabledFolders.prefs ||
    enabled.save !== props.config.enabledFolders.save ||
    conflictPolicy !== props.config.conflictPolicy;

  const anyEnabled = enabled.data || enabled.mods || enabled.prefs || enabled.save;
  const pathsValid =
    cloudFolder.trim().length > 0 && gameFolder.trim().length > 0 && !cloudError && !gameError;

  useEffect(() => {
    props.onDirty(dirty);
  }, [dirty, props]);

  async function pickCloud(): Promise<void> {
    setPicking('cloud');
    try {
      const picked = await api.paths.pickFolder('Pick your cloud-drive folder');
      if (!picked) return;
      setCloudFolder(picked);
      const v = await api.paths.validateCloudFolder(picked);
      if (!v.ok) {
        setCloudError(v.reason ?? 'Folder is not writable.');
        setCloudWarn(null);
      } else {
        setCloudError(null);
        setCloudWarn(v.reason ?? null);
      }
    } catch (err) {
      setCloudError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(null);
    }
  }

  async function pickGame(): Promise<void> {
    setPicking('game');
    try {
      const picked = await api.paths.pickFolder('Pick your Dwarf Fortress game folder');
      if (!picked) return;
      setGameFolder(picked);
      setGameError(null);
    } catch (err) {
      setGameError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(null);
    }
  }

  async function onSave(): Promise<void> {
    if (!anyEnabled || !pathsValid) return;
    setSaving(true);
    try {
      const next = await api.config.save({
        cloudFolder,
        gameFolder,
        enabledFolders: enabled,
        conflictPolicy
      });
      props.onSaved(next);
      props.onToast?.('success', 'Sync settings saved.');
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="settings-section"
      onSubmit={(e): void => {
        e.preventDefault();
        void onSave();
      }}
    >
      <h3 className="settings-section__heading">Sync</h3>

      <div className="settings-field">
        <span className="settings-field__label">Cloud-drive folder</span>
        <div className="settings-path-row">
          <input
            type="text"
            className={`settings-field__input${cloudError ? ' settings-field__input--invalid' : ''}`}
            value={cloudFolder}
            readOnly
            data-testid="settings-cloud-folder"
            aria-invalid={Boolean(cloudError)}
          />
          <button
            type="button"
            className="settings-btn"
            onClick={(): void => void pickCloud()}
            disabled={picking !== null}
            data-testid="settings-cloud-folder-pick"
          >
            {picking === 'cloud' ? 'Picking…' : 'Browse…'}
          </button>
        </div>
        {cloudError && (
          <span className="settings-field__error" role="alert">
            {cloudError}
          </span>
        )}
        {cloudWarn && !cloudError && (
          <span className="settings-field__warn" role="status">
            {cloudWarn}
          </span>
        )}
      </div>

      <div className="settings-field">
        <span className="settings-field__label">Dwarf Fortress folder</span>
        <div className="settings-path-row">
          <input
            type="text"
            className={`settings-field__input${gameError ? ' settings-field__input--invalid' : ''}`}
            value={gameFolder}
            readOnly
            data-testid="settings-game-folder"
            aria-invalid={Boolean(gameError)}
          />
          <button
            type="button"
            className="settings-btn"
            onClick={(): void => void pickGame()}
            disabled={picking !== null}
            data-testid="settings-game-folder-pick"
          >
            {picking === 'game' ? 'Picking…' : 'Browse…'}
          </button>
        </div>
        {gameError && (
          <span className="settings-field__error" role="alert">
            {gameError}
          </span>
        )}
      </div>

      <fieldset className="settings-field">
        <legend className="settings-field__label">Enabled folders</legend>
        {(['save', 'mods', 'prefs', 'data'] as const).map((k) => (
          <label key={k} className="settings-checkbox">
            <input
              type="checkbox"
              checked={enabled[k]}
              onChange={(e): void => setEnabled({ ...enabled, [k]: e.target.checked })}
              data-testid={`settings-folder-${k}`}
            />
            <code>{k}/</code>
          </label>
        ))}
        {!anyEnabled && (
          <span className="settings-field__error" role="alert">
            Pick at least one folder to sync.
          </span>
        )}
      </fieldset>

      <fieldset className="settings-field">
        <legend className="settings-field__label">Conflict policy</legend>
        {(['newer-wins-backup', 'always-prompt', 'backup-only-no-resolve'] as const).map((p) => (
          <label key={p} className="settings-radio">
            <input
              type="radio"
              name="settings-conflict"
              value={p}
              checked={conflictPolicy === p}
              onChange={(): void => setConflictPolicy(p)}
              data-testid={`settings-conflict-${p}`}
            />
            {policyLabel(p)}
          </label>
        ))}
      </fieldset>

      <div className="settings-section__footer">
        <button
          type="submit"
          className="settings-btn settings-btn--primary"
          disabled={!dirty || !anyEnabled || !pathsValid || saving}
          data-testid="settings-sync-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function policyLabel(p: ConflictPolicy): string {
  switch (p) {
    case 'newer-wins-backup':
      return 'Newer wins (with backup)';
    case 'always-prompt':
      return 'Always prompt';
    case 'backup-only-no-resolve':
      return 'Backup only, no auto-resolve';
  }
}

/* Backup */

function BackupTab(props: TabProps): JSX.Element {
  const [keepLastN, setKeepLastN] = useState(props.config.backup.keepLastN);
  const [compress, setCompress] = useState(props.config.backup.compress);
  const [saving, setSaving] = useState(false);

  const keepValid =
    Number.isInteger(keepLastN) && keepLastN >= KEEP_LAST_MIN && keepLastN <= KEEP_LAST_MAX;
  const dirty =
    keepLastN !== props.config.backup.keepLastN || compress !== props.config.backup.compress;

  useEffect(() => {
    props.onDirty(dirty);
  }, [dirty, props]);

  async function onSave(): Promise<void> {
    if (!keepValid) return;
    setSaving(true);
    try {
      const next = await api.config.save({ backup: { keepLastN, compress } });
      props.onSaved(next);
      props.onToast?.('success', 'Backup settings saved.');
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="settings-section"
      onSubmit={(e): void => {
        e.preventDefault();
        void onSave();
      }}
    >
      <h3 className="settings-section__heading">Backup</h3>

      <label className="settings-field">
        <span className="settings-field__label">Keep last N backups</span>
        <input
          type="number"
          className={`settings-field__input${keepValid ? '' : ' settings-field__input--invalid'}`}
          value={keepLastN}
          min={KEEP_LAST_MIN}
          max={KEEP_LAST_MAX}
          step={1}
          onChange={(e): void => setKeepLastN(Number(e.target.value))}
          data-testid="settings-keepLastN"
          aria-invalid={!keepValid}
        />
        {!keepValid && (
          <span className="settings-field__error" role="alert">
            Must be an integer between {KEEP_LAST_MIN} and {KEEP_LAST_MAX}.
          </span>
        )}
      </label>

      <label className="settings-field settings-field--inline">
        <input
          type="checkbox"
          checked={compress}
          onChange={(e): void => setCompress(e.target.checked)}
          data-testid="settings-compress"
        />
        <span>Compress backups (.tar.gz)</span>
      </label>

      <div className="settings-section__footer">
        <button
          type="submit"
          className="settings-btn settings-btn--primary"
          disabled={!dirty || !keepValid || saving}
          data-testid="settings-backup-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/* Monitor */

function MonitorTab(props: TabProps): JSX.Element {
  const [enabled, setEnabled] = useState(props.config.monitor.enabled);
  const [pollIntervalMs, setPollIntervalMs] = useState(props.config.monitor.pollIntervalMs);
  const [onGameStart, setOnGameStart] = useState(props.config.monitor.onGameStart);
  const [onGameExit, setOnGameExit] = useState(props.config.monitor.onGameExit);
  const [saving, setSaving] = useState(false);

  const pollValid =
    Number.isFinite(pollIntervalMs) &&
    pollIntervalMs >= POLL_INTERVAL_MIN_MS &&
    pollIntervalMs <= POLL_INTERVAL_MAX_MS;
  const dirty =
    enabled !== props.config.monitor.enabled ||
    pollIntervalMs !== props.config.monitor.pollIntervalMs ||
    onGameStart !== props.config.monitor.onGameStart ||
    onGameExit !== props.config.monitor.onGameExit;

  useEffect(() => {
    props.onDirty(dirty);
  }, [dirty, props]);

  async function onSave(): Promise<void> {
    if (!pollValid) return;
    setSaving(true);
    try {
      const next = await api.config.save({
        monitor: { enabled, pollIntervalMs, onGameStart, onGameExit }
      });
      props.onSaved(next);
      props.onToast?.('success', 'Monitor settings saved.');
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="settings-section"
      onSubmit={(e): void => {
        e.preventDefault();
        void onSave();
      }}
    >
      <h3 className="settings-section__heading">Monitor</h3>

      <label className="settings-field settings-field--inline">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e): void => setEnabled(e.target.checked)}
          data-testid="settings-monitor-enabled"
        />
        <span>Enable Dwarf Fortress process monitor</span>
      </label>

      <label className="settings-field">
        <span className="settings-field__label">Poll interval (ms)</span>
        <input
          type="number"
          className={`settings-field__input${pollValid ? '' : ' settings-field__input--invalid'}`}
          value={pollIntervalMs}
          min={POLL_INTERVAL_MIN_MS}
          max={POLL_INTERVAL_MAX_MS}
          step={100}
          onChange={(e): void => setPollIntervalMs(Number(e.target.value))}
          data-testid="settings-poll-interval"
          aria-invalid={!pollValid}
        />
        {!pollValid && (
          <span className="settings-field__error" role="alert">
            Must be between {POLL_INTERVAL_MIN_MS} and {POLL_INTERVAL_MAX_MS} ms.
          </span>
        )}
      </label>

      <label className="settings-field">
        <span className="settings-field__label">When DF starts</span>
        <select
          className="settings-field__input"
          value={onGameStart}
          onChange={(e): void =>
            setOnGameStart(e.target.value as AppConfig['monitor']['onGameStart'])
          }
          data-testid="settings-onstart"
        >
          <option value="do-nothing">Do nothing</option>
          <option value="prompt-pull">Prompt to pull</option>
          <option value="auto-pull">Auto pull</option>
        </select>
      </label>

      <label className="settings-field">
        <span className="settings-field__label">When DF exits</span>
        <select
          className="settings-field__input"
          value={onGameExit}
          onChange={(e): void =>
            setOnGameExit(e.target.value as AppConfig['monitor']['onGameExit'])
          }
          data-testid="settings-onexit"
        >
          <option value="do-nothing">Do nothing</option>
          <option value="prompt-push">Prompt to push</option>
          <option value="auto-push">Auto push</option>
        </select>
      </label>

      <div className="settings-section__footer">
        <button
          type="submit"
          className="settings-btn settings-btn--primary"
          disabled={!dirty || !pollValid || saving}
          data-testid="settings-monitor-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/* Excludes */

function ExcludesTab(props: TabProps): JSX.Element {
  const [text, setText] = useState(props.config.excludeGlobs.join('\n'));
  const [saving, setSaving] = useState(false);

  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const validation = useMemo(() => validateGlobLines(lines), [lines]);

  const original = props.config.excludeGlobs.join('\n');
  const dirty = text !== original;

  useEffect(() => {
    props.onDirty(dirty);
  }, [dirty, props]);

  async function onSave(): Promise<void> {
    if (validation.invalidIndexes.length > 0) return;
    setSaving(true);
    try {
      const cleaned = lines.map((l) => l.trim()).filter((l) => l.length > 0);
      const next = await api.config.save({ excludeGlobs: cleaned });
      props.onSaved(next);
      props.onToast?.('success', 'Excludes saved.');
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function onReset(): void {
    setText([...DEFAULT_EXCLUDE_GLOBS].join('\n'));
  }

  return (
    <form
      className="settings-section"
      onSubmit={(e): void => {
        e.preventDefault();
        void onSave();
      }}
    >
      <h3 className="settings-section__heading">Excludes</h3>
      <p className="settings-section__copy">
        One glob per line. Lines starting with <code>#</code> are treated as comments.
      </p>

      <textarea
        className="settings-field__textarea"
        value={text}
        onChange={(e): void => setText(e.target.value)}
        rows={10}
        spellCheck={false}
        data-testid="settings-excludes-textarea"
        aria-invalid={validation.invalidIndexes.length > 0}
        aria-describedby="settings-excludes-help"
      />

      <ul className="settings-excludes__lines" data-testid="settings-excludes-validation">
        {lines.map((line, i) => {
          if (line.trim().length === 0) return null;
          if (line.trim().startsWith('#')) {
            return (
              <li key={i} className="settings-excludes__line settings-excludes__line--comment">
                <span aria-hidden="true">{'#'}</span>
                <code>{line.trim()}</code>
              </li>
            );
          }
          const invalid = validation.invalidIndexes.includes(i);
          return (
            <li
              key={i}
              className={`settings-excludes__line${
                invalid ? ' settings-excludes__line--invalid' : ''
              }`}
              data-testid={invalid ? `settings-excludes-invalid-${i}` : undefined}
            >
              <span aria-hidden="true" className="settings-excludes__mark">
                {invalid ? '✗' : '✓'}
              </span>
              <code>{line.trim()}</code>
            </li>
          );
        })}
      </ul>

      <div className="settings-section__footer">
        <button
          type="button"
          className="settings-btn"
          onClick={onReset}
          data-testid="settings-excludes-reset"
        >
          Reset to defaults
        </button>
        <span className="settings-section__spacer" />
        <button
          type="submit"
          className="settings-btn settings-btn--primary"
          disabled={!dirty || validation.invalidIndexes.length > 0 || saving}
          data-testid="settings-excludes-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/**
 * Validate each non-blank, non-comment line by attempting to compile it
 * with picomatch's strict mode. Returns the indexes of lines that fail.
 *
 * `strictBrackets: true` makes picomatch throw on unbalanced `[`/`(`
 * groups, which is the kind of typo we actually want to surface.
 * Without it, picomatch silently accepts the partial bracket and the
 * runtime match will quietly never hit, which is worse for users.
 */
function validateGlobLines(lines: string[]): { invalidIndexes: number[] } {
  const invalid: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    try {
      const re = picomatch.makeRe(trimmed, { strictBrackets: true });
      if (!re) invalid.push(i);
    } catch {
      invalid.push(i);
    }
  }
  return { invalidIndexes: invalid };
}

/* About */

function AboutTab(props: { onToast?: TabProps['onToast'] }): JSX.Element {
  const [version, setVersion] = useState<string>('—');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await api.app.getVersion();
        if (!cancelled) setVersion(v);
      } catch {
        // Ignore.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function safeOpenExternal(url: string, label: string): Promise<void> {
    try {
      await api.app.openExternal(url);
    } catch (err) {
      props.onToast?.(
        'error',
        `Could not open ${label}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function openLogsFolder(): Promise<void> {
    try {
      await api.app.openLogsFolder();
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    }
  }

  async function openBackupsFolder(): Promise<void> {
    try {
      await api.app.openBackupsFolder();
    } catch (err) {
      props.onToast?.('error', err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section__heading">About</h3>
      <p className="settings-section__copy">
        df-syncer-windows v<span data-testid="settings-about-version">{version}</span>
      </p>
      <p className="settings-section__copy">
        Sync Dwarf Fortress saves, mods, and prefs across PCs via a local cloud-drive folder.
      </p>

      <ul className="settings-about__links">
        <li>
          <button
            type="button"
            className="settings-link"
            data-testid="settings-link-repo"
            onClick={(): void => {
              void safeOpenExternal(
                'https://github.com/charlesjones-dev/df-syncer-windows',
                'GitHub repo'
              );
            }}
          >
            GitHub repository
          </button>
        </li>
        <li>
          <button
            type="button"
            className="settings-link"
            data-testid="settings-link-wiki"
            onClick={(): void => {
              void safeOpenExternal('https://dwarffortresswiki.org/', 'DF wiki');
            }}
          >
            Dwarf Fortress wiki
          </button>
        </li>
        <li>
          <button
            type="button"
            className="settings-link"
            data-testid="settings-link-license"
            onClick={(): void => {
              void safeOpenExternal('https://opensource.org/license/mit/', 'MIT license');
            }}
          >
            MIT license
          </button>
        </li>
      </ul>

      <div className="settings-section__footer">
        <button
          type="button"
          className="settings-btn"
          onClick={(): void => {
            void openLogsFolder();
          }}
          data-testid="settings-open-logs"
        >
          Open Logs Folder
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={(): void => {
            void openBackupsFolder();
          }}
          data-testid="settings-open-backups"
        >
          Open Backups Folder
        </button>
      </div>
    </div>
  );
}
