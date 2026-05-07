/**
 * AppTray — Phase 10.
 *
 * Owns the system tray icon, its right-click context menu, and the
 * Windows toast notifications fired by the process-monitor's
 * Running→Exit and Idle→Running transitions.
 *
 * Wiring (see `src/main/index.ts`):
 *
 *     monitor.on('state-change', (s) => {
 *       tray.updateForState(s);
 *       tray.applyPolicy(s);  // Maybe show notification / auto-push.
 *       win.webContents.send(IPC.PROCESS_ON_STATE_CHANGE, s);
 *     });
 *
 * The tray refers back to the `runSync(direction)` callback the main
 * process supplies, which mirrors the dashboard's flow: build a plan
 * and apply if no conflicts. If conflicts surface, the tray focuses
 * the dashboard window and lets the user resolve there (silent
 * auto-apply on a conflict-bearing plan would violate the
 * non-destructive guarantee).
 */

import {
  app,
  Menu,
  Notification,
  Tray,
  nativeImage,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron';
import path from 'node:path';
import type { AppConfig, SyncDirection, SyncHistoryEntry } from '@shared/types';
import { AUTO_PUSH_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, type ProcessMonitor } from './process-monitor';

/** Windows AppUserModelID — required for `Notification` action buttons. */
export const APP_USER_MODEL_ID = 'dev.charlesjones.dfsyncer';

/**
 * Threshold multiplier for the "unusually large push" heuristic
 * (§7 of the implementation plan). If the planned bytes exceed
 * `LARGE_PUSH_MULTIPLIER × rolling7DayAverage`, auto-push falls back
 * to a prompt.
 */
export const LARGE_PUSH_MULTIPLIER = 2;

/** Number of days for the rolling-average heuristic. */
export const ROLLING_DAYS = 7;

/**
 * Tooltip strings keyed by the tray's coarse state. The tray itself
 * tracks the current one and updates the icon's tooltip on every
 * state-change.
 */
const TOOLTIPS = {
  idle: 'df-syncer-windows — idle',
  running: 'df-syncer-windows — DF running',
  syncing: 'df-syncer-windows — sync in progress',
  error: 'df-syncer-windows — error'
} as const;

type TrayCoarseState = keyof typeof TOOLTIPS;

/**
 * Direction supplied to the `runSync` callback. Mirrors the dashboard's
 * SyncControls button set (sans Dry-Run; the tray doesn't expose dry).
 */
export type TraySyncDirection = SyncDirection;

/**
 * Caller-supplied dependencies. The tray itself does no IO besides
 * reading the icon path; everything else flows through these hooks so
 * the main process owns lifecycle / window focus / sync orchestration.
 */
export interface AppTrayOptions {
  /** Main window to focus when "Open" is clicked. */
  window: BrowserWindow | null;
  /** Process monitor whose `paused` flag the menu reflects. */
  monitor: ProcessMonitor;
  /** Initial config; the tray reads `monitor.onGameExit/onGameStart`. */
  config: AppConfig;
  /**
   * Build + apply a plan in the given direction. Returns once the apply
   * settles (or rejects with the structured error from `applyPlan`).
   * The tray awaits this so the tooltip can flip to "syncing" while
   * it runs.
   */
  runSync: (direction: TraySyncDirection) => Promise<void>;
  /**
   * Read history (newest first). Used by the auto-push heuristic to
   * compute the rolling 7-day average. Defaults to a no-op returning
   * `[]` so tests don't need to wire history.
   */
  listHistory?: () => Promise<SyncHistoryEntry[]>;
  /**
   * Plan-bytes probe. Given the direction, returns the planned bytes
   * the auto-push heuristic compares against the rolling average.
   * Optional — when undefined the heuristic is skipped (auto-push runs
   * unconditionally).
   */
  estimatePlanBytes?: (direction: TraySyncDirection) => Promise<number>;
  /** Override `Date.now()` for deterministic tests. */
  clock?: () => number;
  /** Override `path.join(__dirname, '..', '..', 'resources', 'icon.ico')`. */
  iconPath?: string;
  /**
   * Override the Tray / Notification ctors for tests. Both default to
   * the Electron impls in production.
   */
  trayCtor?: new (image: NativeImage | string) => Tray;
  notificationCtor?: typeof Notification;
  /**
   * Optional structured logger. When present, the tray records every
   * notification dispatch decision (supported? show? failed?) so a
   * silenced Windows toast surface is debuggable from the rotating log
   * file.
   */
  logger?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

/**
 * AppTray — system-tray icon + right-click menu + on-state notifications.
 *
 * Construction does not throw if the OS doesn't support the tray (e.g.
 * a headless test environment): the constructor swallows the inner
 * Tray-ctor error and the resulting instance is a no-op. This lets the
 * main process keep running even on an exotic OS configuration.
 */
export class AppTray {
  private readonly opts: AppTrayOptions;
  private readonly notificationCtor: typeof Notification;
  private tray: Tray | null = null;
  private coarseState: TrayCoarseState = 'idle';
  private currentConfig: AppConfig;
  private menu: Menu | null = null;
  private disposed = false;

  constructor(opts: AppTrayOptions) {
    this.opts = opts;
    this.currentConfig = opts.config;
    this.notificationCtor = opts.notificationCtor ?? Notification;

    // Ensure Windows AppUserModelID is set so notification actions work.
    // The main process should also call `app.setAppUserModelId` once on
    // startup; this is a defensive duplicate.
    if (typeof app.setAppUserModelId === 'function') {
      try {
        app.setAppUserModelId(APP_USER_MODEL_ID);
      } catch {
        // Some platforms / test envs don't implement it; ignore.
      }
    }

    try {
      const TrayCtor = opts.trayCtor ?? Tray;
      const iconPath = opts.iconPath ?? defaultIconPath();
      const image = nativeImage.createFromPath(iconPath);
      this.tray = new TrayCtor(image.isEmpty() ? iconPath : image);
      this.tray.setToolTip(TOOLTIPS.idle);
      this.tray.on('click', () => this.openWindow());
      this.tray.on('double-click', () => this.openWindow());
      this.refreshMenu();
    } catch (err) {
      // Headless / test env — leave the tray unset so the rest of the
      // main process keeps working.
      console.warn(`tray: failed to create system tray: ${(err as Error).message}`);
      this.tray = null;
    }
  }

  /**
   * Apply the latest config (e.g. after the user changes
   * `monitor.onGameExit` from Settings). Re-renders the menu so the
   * Pause Monitor checkbox / labels stay current.
   */
  setConfig(config: AppConfig): void {
    this.currentConfig = config;
    this.refreshMenu();
  }

  /**
   * Update the tray for a `DfState` change. Adjusts the tooltip + icon
   * to reflect Running vs. Idle. The notification policy is *not*
   * applied here — call `applyPolicy(state)` for that, separately, so
   * the tray can be tested independently of the policy hooks.
   */
  updateForState(running: boolean): void {
    if (this.coarseState === 'syncing' || this.coarseState === 'error') {
      // Don't override syncing/error tooltips; they clear themselves
      // when the apply finishes.
      return;
    }
    this.coarseState = running ? 'running' : 'idle';
    this.applyTooltip();
  }

  /**
   * Surface a sync-in-progress tooltip. Called by the wiring code in
   * `index.ts` around the `runSync` callback.
   */
  setSyncing(syncing: boolean): void {
    if (syncing) {
      this.coarseState = 'syncing';
    } else {
      // Recompute idle/running from the monitor's last observation.
      this.coarseState = this.opts.monitor.getStatus().running ? 'running' : 'idle';
    }
    this.applyTooltip();
  }

  /**
   * Surface a sync-error tooltip. The caller is expected to clear the
   * error eventually by calling `setSyncing(false)` (or
   * `updateForState(running)`).
   */
  setError(message: string): void {
    this.coarseState = 'error';
    if (this.tray) {
      this.tray.setToolTip(`${TOOLTIPS.error}: ${truncate(message, 80)}`);
    }
  }

  /**
   * Apply the configured `onGameStart` / `onGameExit` policy to a
   * state-change event from the monitor. Returns nothing; side effects
   * are notification dispatch and (for auto-push) the `runSync` call.
   */
  async applyPolicy(payload: { running: boolean; prompt?: 'on-start' | 'on-exit' }): Promise<void> {
    // Idle → Running: fired with `prompt: 'on-start'` from the monitor.
    if (payload.running && payload.prompt === 'on-start') {
      switch (this.currentConfig.monitor.onGameStart) {
        case 'do-nothing':
          return;
        case 'prompt-pull':
          this.notifyPromptPull();
          return;
        case 'auto-pull':
          await this.runWithLargePushFallback('pull');
          return;
      }
    }
    // Running → Idle (after cooldown): `prompt: 'on-exit'`, running:false.
    if (!payload.running && payload.prompt === 'on-exit') {
      switch (this.currentConfig.monitor.onGameExit) {
        case 'do-nothing':
          return;
        case 'prompt-push':
          this.notifyPromptPush();
          return;
        case 'auto-push':
          await this.runWithLargePushFallback('push');
          return;
      }
    }
  }

  /**
   * The "unusually large" heuristic. Compares planned bytes against the
   * rolling 7-day average from history; if `bytes > 2 × avg`, falls
   * back to the prompt path instead of auto-pushing.
   */
  async runWithLargePushFallback(direction: TraySyncDirection): Promise<void> {
    if (this.opts.estimatePlanBytes && this.opts.listHistory) {
      try {
        const planned = await this.opts.estimatePlanBytes(direction);
        const history = await this.opts.listHistory();
        const avg = computeRolling7DayAverage(history, this.now());
        if (avg > 0 && planned > LARGE_PUSH_MULTIPLIER * avg) {
          // Fall back to prompt — refuse to silently push a payload
          // that's >2× our normal cadence.
          if (direction === 'push') {
            this.notifyPromptPush(
              `This push is unusually large (${formatBytes(planned)}, > 2× recent average). Review before applying.`
            );
          } else {
            this.notifyPromptPull(
              `This pull is unusually large (${formatBytes(planned)}, > 2× recent average). Review before applying.`
            );
          }
          // Adjust the cooldown for the next exit if we're now in
          // prompt-mode for this transition.
          if (direction === 'push') {
            this.opts.monitor.setCooldownMs(DEFAULT_COOLDOWN_MS);
          }
          return;
        }
      } catch (err) {
        // Heuristic failures shouldn't block the auto-push path.
        console.warn(`tray: large-push heuristic failed: ${(err as Error).message}`);
      }
    }
    await this.executeSync(direction);
  }

  /**
   * Imperatively run a sync (Sync Now menu item, notification action).
   * Sets the syncing tooltip, calls `runSync`, clears tooltip on
   * settle. Errors are surfaced via `setError`.
   */
  async executeSync(direction: TraySyncDirection): Promise<void> {
    this.setSyncing(true);
    try {
      await this.opts.runSync(direction);
      this.setSyncing(false);
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Open or focus the main window. Invoked from the "Open" menu item
   * and from notification clicks.
   */
  openWindow(): void {
    const win = this.opts.window;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  /** Cleanup: destroy the icon, clear listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.tray) {
      try {
        this.tray.removeAllListeners();
        this.tray.destroy();
      } catch {
        // Ignore — best-effort.
      }
      this.tray = null;
    }
    this.menu = null;
  }

  /* ───────────────── notifications ───────────────── */

  private notifyPromptPush(extraBody?: string): void {
    const log = this.opts.logger;
    const supported = this.notificationsAvailable();
    log?.info('tray: notify on-exit', { supported });
    if (!supported) return;
    try {
      const n = new this.notificationCtor({
        title: 'Dwarf Fortress closed',
        body: extraBody ?? 'Push your latest saves and prefs to the cloud?',
        actions: [{ type: 'button', text: 'Push' }]
      });
      n.on('action', () => {
        this.openWindow();
        void this.executeSync('push');
      });
      n.on('click', () => {
        this.openWindow();
      });
      n.on('failed', (_e, error) => {
        log?.warn('tray: notification failed (event)', { error });
      });
      n.show();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (log) log.warn('tray: notification failed (throw)', { message });
      else console.warn(`tray: notification failed: ${message}`);
    }
  }

  private notifyPromptPull(extraBody?: string): void {
    const log = this.opts.logger;
    const supported = this.notificationsAvailable();
    log?.info('tray: notify on-start', { supported });
    if (!supported) return;
    const warning =
      'Pulling now is unsafe if a save is already loaded — close DF first or wait until the menu.';
    const body = extraBody ? `${extraBody}\n${warning}` : `Pull from cloud?\n${warning}`;
    try {
      const n = new this.notificationCtor({
        title: 'Dwarf Fortress launching',
        body,
        actions: [{ type: 'button', text: 'Pull' }]
      });
      n.on('action', () => {
        this.openWindow();
        void this.executeSync('pull');
      });
      n.on('click', () => {
        this.openWindow();
      });
      n.on('failed', (_e, error) => {
        log?.warn('tray: notification failed (event)', { error });
      });
      n.show();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (log) log.warn('tray: notification failed (throw)', { message });
      else console.warn(`tray: notification failed: ${message}`);
    }
  }

  private notificationsAvailable(): boolean {
    try {
      // `Notification.isSupported()` exists in real Electron; not
      // always in test mocks.
      const ctor = this.notificationCtor as unknown as { isSupported?: () => boolean };
      if (typeof ctor.isSupported === 'function') {
        return ctor.isSupported();
      }
    } catch {
      // Ignore.
    }
    return true;
  }

  /* ───────────────── menu ───────────────── */

  private refreshMenu(): void {
    if (!this.tray) return;
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'Open',
        click: () => this.openWindow()
      },
      {
        label: 'Sync Now',
        submenu: [
          {
            label: 'Pull',
            click: () => {
              void this.executeSync('pull');
            }
          },
          {
            label: 'Push',
            click: () => {
              void this.executeSync('push');
            }
          },
          {
            label: 'Full Sync',
            click: () => {
              void this.executeSync('full');
            }
          }
        ]
      },
      {
        label: 'Pause Monitor',
        type: 'checkbox',
        checked: this.opts.monitor.isPaused,
        click: () => {
          if (this.opts.monitor.isPaused) {
            this.opts.monitor.resume();
          } else {
            this.opts.monitor.pause();
          }
          this.refreshMenu();
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        }
      }
    ];
    this.menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(this.menu);
  }

  /* ───────────────── helpers ───────────────── */

  private applyTooltip(): void {
    if (!this.tray) return;
    this.tray.setToolTip(TOOLTIPS[this.coarseState]);
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }
}

/* ───────────────── pure helpers ───────────────── */

/**
 * Compute the rolling N-day average of `bytesWritten` from history.
 * Entries are weighted equally; the average is over the cutoff window
 * (`now - N×24h .. now`) and divided by `N` so a quiet day averages in
 * as 0 bytes rather than being dropped.
 *
 * Returns 0 when no entries are in the window (so the heuristic is a
 * no-op until at least one push has been recorded).
 */
export function computeRolling7DayAverage(
  history: readonly SyncHistoryEntry[],
  nowMs: number = Date.now()
): number {
  return computeRollingAverage(history, ROLLING_DAYS, nowMs);
}

/**
 * Generalised rolling average. Exported for tests to verify edge cases
 * (empty history, all entries outside window, etc.) without committing
 * to the 7-day default.
 */
export function computeRollingAverage(
  history: readonly SyncHistoryEntry[],
  days: number,
  nowMs: number = Date.now()
): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const windowMs = days * 24 * 60 * 60 * 1000;
  const cutoff = nowMs - windowMs;
  let total = 0;
  let count = 0;
  for (const entry of history) {
    const t = parseTimestampMs(entry.timestamp);
    if (t === null) continue;
    if (t < cutoff || t > nowMs) continue;
    if (!entry.result.ok) continue;
    total += entry.result.bytesWritten;
    count += 1;
  }
  if (count === 0) return 0;
  return total / days;
}

/**
 * Parse the executor's timestamp shape (Windows-safe ISO-derived form
 * from `buildTimestamp()`). Returns ms-since-epoch or `null` on parse
 * failure. The format is `YYYY-MM-DDTHH-MM-SS-mmmZ` (colons replaced
 * with hyphens). We accept both the canonical ISO `YYYY-MM-DDTHH:MM:SS.mmmZ`
 * and the file-safe variant.
 */
function parseTimestampMs(stamp: string): number | null {
  if (!stamp) return null;
  const direct = Date.parse(stamp);
  if (!Number.isNaN(direct)) return direct;
  // File-safe variant: `2026-05-07T12-34-56-789Z`. Convert back.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (m) {
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function defaultIconPath(): string {
  // electron-vite outputs main to `out/main`. The repo's `resources/`
  // sits at the project root, so go up two levels in production. In
  // dev (electron-vite dev), `__dirname` is the same.
  return path.join(__dirname, '..', '..', 'resources', 'icon.ico');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* re-exports so consumers don't have to dig into process-monitor for
 * the cooldown constants. */
export { AUTO_PUSH_COOLDOWN_MS, DEFAULT_COOLDOWN_MS };
