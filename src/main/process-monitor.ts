/**
 * Process monitor — Phase 10.
 *
 * Polls the Windows process table via the built-in `tasklist.exe` and
 * emits transitions on a `DfStateChange` event. Implements the small
 * state machine
 * documented in §7 of the implementation plan:
 *
 *     Idle ──game starts──▶ Running ──game exits──▶ CooldownPrompt(15s)
 *      ▲                                              │
 *      └──────────────────────────────────────────────┘
 *
 * - `Idle → Running`: emitted with `prompt: 'on-start'` so the tray can
 *   surface the "DF launching — pull?" notification (the renderer's
 *   sync gate flips immediately on the same event).
 * - `Running → Idle`: emits `running: false` immediately so the
 *   dashboard's gate releases, then schedules a cooldown timer
 *   (default 15 s; 5 s when `onGameExit === 'auto-push'`). When the
 *   timer fires we emit a *second* event with `prompt: 'on-exit'` and
 *   `running: false` so the tray can show the on-exit prompt /
 *   auto-push trigger.
 *
 * Pause / resume:
 *   - The executor calls `pause()` before applying a plan and
 *     `resume()` after. While paused, polling continues but no events
 *     are emitted (so the renderer's badge doesn't flicker during apply).
 *   - On `resume()` we re-emit the latest known state so any UI that
 *     needs a refresh after the pause can hydrate.
 *
 * Detection rule: case-insensitive match on the executable basename
 * `Dwarf Fortress.exe`. `tasklist` returns this in the "Image Name"
 * field. Full path / command line are not requested (`/V` is omitted)
 * since name-only matching is sufficient and faster.
 */

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DfStateChange } from '@shared/types';

const execFileAsync = promisify(execFile);

/**
 * Minimal Windows process lister. Uses the built-in `tasklist.exe` from
 * `%WINDIR%\System32`, which is always available and unaffected by asar
 * packaging — unlike `ps-list@8`, which spawns a vendored `fastlist.exe`
 * from inside `node_modules/ps-list/vendor/` and silently fails when
 * that path resolves into `app.asar`.
 *
 * Output format with `/FO CSV /NH`:
 *   "Image Name","PID","Session Name","Session#","Mem Usage"
 * The `/NH` flag suppresses the header. Data fields are not localized,
 * so this works on non-English Windows.
 */
async function listWindowsProcesses(): Promise<{ pid: number; name: string }[]> {
  const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const out: { pid: number; name: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    // First two CSV fields: name, pid. Both quoted, no embedded quotes.
    const m = /^"([^"]*)","(\d+)"/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[2], 10);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, name: m[1] });
  }
  return out;
}

/** Process name we match (case-insensitive). */
export const DF_PROCESS_NAME = 'Dwarf Fortress.exe';
const DF_PROCESS_NAME_LOWER = DF_PROCESS_NAME.toLowerCase();

/** Default cooldown for the on-exit prompt (15 s per §7). */
export const DEFAULT_COOLDOWN_MS = 15_000;
/** Cooldown when the policy is `auto-push` (5 s per §7). */
export const AUTO_PUSH_COOLDOWN_MS = 5_000;

/** Default poll interval if config doesn't override. */
export const DEFAULT_POLL_INTERVAL_MS = 3000;

/**
 * Event map. The single `state-change` event carries both Idle/Running
 * transitions and the cooldown-fired `prompt` signal.
 */
export type ProcessMonitorEvents = {
  'state-change': [DfStateChange];
};

export interface ProcessMonitorOptions {
  /** Initial poll interval; default 3000 ms. */
  pollIntervalMs?: number;
  /** Cooldown before the on-exit prompt fires. Default 15 s. */
  cooldownMs?: number;
  /**
   * Override the process lister for tests. Must return a list of
   * `{ pid, name }` (additional fields ignored). When unset, we shell
   * out to Windows' built-in `tasklist.exe`.
   */
  psList?: () => Promise<{ pid: number; name: string }[]>;
  /**
   * Optional structured logger. When provided, poll failures and the
   * first successful poll outcome land here instead of `console.warn`
   * (which doesn't reach the rotating log file in packaged builds).
   * Tests typically don't pass one.
   */
  logger?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
  };
  /** Override `Date.now()` for deterministic tests. */
  clock?: () => number;
  /**
   * Override `setTimeout`/`clearTimeout`. Tests pass a fake-timer pair
   * so the cooldown can be advanced without `vi.useFakeTimers()` racing
   * the poll loop. Defaults to globals.
   */
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Internal state machine label. `Idle` and `Running` are observable;
 * `CooldownPrompt` is the transient post-exit window before the prompt
 * is fired.
 */
type MachineState = 'idle' | 'running' | 'cooldown-prompt';

/**
 * The DF process monitor.
 *
 * Construct, optionally call `setPollInterval`, then `start()`. Listen
 * on `'state-change'`. `stop()` and `dispose()` clear the timer and any
 * pending cooldown. The class extends `EventEmitter` and provides
 * narrowed `on` / `off` / `emit` overloads via the typed `Events` map.
 */
export class ProcessMonitor extends EventEmitter {
  override on<K extends keyof ProcessMonitorEvents>(
    event: K,
    listener: (...args: ProcessMonitorEvents[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof ProcessMonitorEvents>(
    event: K,
    listener: (...args: ProcessMonitorEvents[K]) => void
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof ProcessMonitorEvents>(
    event: K,
    ...args: ProcessMonitorEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  private state: MachineState = 'idle';
  private latest: DfStateChange = { running: false };
  private pollIntervalMs: number;
  private cooldownMs: number;

  private interval: ReturnType<typeof setInterval> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  private paused = false;
  private polling = false;

  private readonly opts: ProcessMonitorOptions;

  constructor(options: ProcessMonitorOptions = {}) {
    super();
    this.opts = options;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /**
   * Begin polling. Idempotent: a second `start()` call is a no-op.
   * Performs an immediate poll so the first state arrives without
   * waiting a full interval.
   */
  start(): void {
    if (this.interval !== null) return;
    // Kick off an immediate poll so the dashboard gets state on
    // startup; intentionally non-awaited so callers don't block.
    void this.poll();
    this.interval = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    // Allow Node to exit if this is the only timer outstanding (e.g.
    // during tests). The tray keeps the app alive in production.
    if (typeof this.interval === 'object' && this.interval && 'unref' in this.interval) {
      (this.interval as NodeJS.Timeout).unref();
    }
  }

  /** Stop polling and cancel any pending cooldown timer. */
  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.cooldownTimer !== null) {
      this.clearTimer(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  /**
   * Change the poll cadence. If currently running, restarts the timer.
   * If stopped, only the stored interval is updated.
   */
  setPollInterval(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`setPollInterval: ms must be a positive number, got ${ms}`);
    }
    this.pollIntervalMs = ms;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = setInterval(() => {
        void this.poll();
      }, this.pollIntervalMs);
      if (typeof this.interval === 'object' && this.interval && 'unref' in this.interval) {
        (this.interval as NodeJS.Timeout).unref();
      }
    }
  }

  /**
   * Adjust the cooldown window. Used by the tray when the policy
   * changes (15 s for prompt, 5 s for auto-push).
   */
  setCooldownMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`setCooldownMs: ms must be a non-negative number, got ${ms}`);
    }
    this.cooldownMs = ms;
  }

  /** Suspend event emission. Polling continues so resume sees fresh state. */
  pause(): void {
    this.paused = true;
  }

  /** Resume event emission and re-broadcast the latest known state. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // Best-effort hydrate — emit current state so any subscriber that
    // missed updates during the pause window can refresh.
    this.emit('state-change', { ...this.latest });
  }

  /** True while paused. Useful for tray's "Pause Monitor" toggle UI. */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Synchronously return the most recent observation. The state is
   * derived from the last poll; before the first poll completes this
   * returns `{ running: false }`.
   */
  getStatus(): DfStateChange {
    return { ...this.latest };
  }

  /** Hard cleanup. Equivalent to `stop()` plus `removeAllListeners()`. */
  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  /* ───────────────── internal ───────────────── */

  /** Becomes true after the first successful poll completes. Used to
   *  log a one-shot "monitor: first poll" line so packaged builds can
   *  prove the lister is working without spamming the log on every tick. */
  private firstPollDone = false;

  /**
   * One poll cycle. Concurrency-guarded with `this.polling` so a slow
   * tasklist call on Windows doesn't pile up overlapping requests.
   */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const list = await this.callPsList();
      const match = findDf(list);
      const now = this.now();
      if (!this.firstPollDone) {
        this.firstPollDone = true;
        this.opts.logger?.info('monitor: first poll', {
          processCount: list.length,
          dfFound: match !== null,
          ...(match ? { pid: match.pid, name: match.name } : {})
        });
      }
      if (match && this.state !== 'running') {
        // Idle → Running. Cancel any pending cooldown (stale from a
        // previous exit→start in <cooldownMs).
        this.cancelCooldown();
        this.state = 'running';
        this.latest = {
          running: true,
          pid: match.pid,
          since: new Date(now).toISOString()
        };
        this.tryEmit({ ...this.latest, prompt: 'on-start' });
        return;
      }
      if (!match && this.state === 'running') {
        // Running → Idle. Emit `running: false` immediately so the
        // dashboard's sync gate releases, then schedule the cooldown.
        this.state = 'cooldown-prompt';
        this.latest = { running: false };
        this.tryEmit({ ...this.latest });
        this.scheduleCooldown();
        return;
      }
      if (match && this.state === 'running') {
        // Stable Running. Update pid if it changed (DF restarted in the
        // same poll window — rare but possible).
        if (this.latest.pid !== match.pid) {
          this.latest = {
            ...this.latest,
            pid: match.pid,
            since: new Date(now).toISOString()
          };
          this.tryEmit({ ...this.latest });
        }
      }
      // Stable Idle / CooldownPrompt: no-op; the cooldown timer drives
      // the prompt emission.
    } catch (err) {
      // Lister failures are best-effort — log and try again next tick.
      const message = err instanceof Error ? err.message : String(err);
      if (this.opts.logger) {
        this.opts.logger.warn('monitor: poll failed', { message });
      } else {
        console.warn(`process-monitor: poll failed: ${message}`);
      }
    } finally {
      this.polling = false;
    }
  }

  private scheduleCooldown(): void {
    this.cancelCooldown();
    if (this.cooldownMs <= 0) {
      // Zero-cooldown: fire prompt immediately, on next tick to keep
      // emit ordering (running:false then prompt:on-exit).
      this.cooldownTimer = this.setTimer(() => this.firePrompt(), 0);
      return;
    }
    this.cooldownTimer = this.setTimer(() => this.firePrompt(), this.cooldownMs);
  }

  private cancelCooldown(): void {
    if (this.cooldownTimer !== null) {
      this.clearTimer(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private firePrompt(): void {
    this.cooldownTimer = null;
    if (this.state !== 'cooldown-prompt') return;
    this.state = 'idle';
    this.latest = { running: false };
    this.tryEmit({ running: false, prompt: 'on-exit' });
  }

  private tryEmit(payload: DfStateChange): void {
    if (this.paused) return;
    this.emit('state-change', payload);
  }

  private async callPsList(): Promise<{ pid: number; name: string }[]> {
    if (this.opts.psList) return this.opts.psList();
    return listWindowsProcesses();
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  private setTimer(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    if (this.opts.setTimeout) return this.opts.setTimeout(cb, ms);
    const handle = setTimeout(cb, ms);
    if (typeof handle === 'object' && handle && 'unref' in handle) {
      (handle as NodeJS.Timeout).unref();
    }
    return handle;
  }

  private clearTimer(handle: ReturnType<typeof setTimeout>): void {
    if (this.opts.clearTimeout) {
      this.opts.clearTimeout(handle);
      return;
    }
    clearTimeout(handle);
  }
}

/**
 * Find the DF process in a list (case-insensitive basename match).
 * Exported so the tray / tests can re-use the canonical detection rule.
 */
export function findDf(
  list: { pid: number; name: string }[]
): { pid: number; name: string } | null {
  for (const p of list) {
    if (typeof p.name !== 'string') continue;
    if (p.name.toLowerCase() === DF_PROCESS_NAME_LOWER) {
      return p;
    }
  }
  return null;
}
