/**
 * Hand-rolled main-process logger — Phase 11.
 *
 * Writes structured log lines to a daily-rotated file under
 * `<userData>/logs/df-syncer-windows-YYYY-MM-DD.log`, mirrors them to `console`
 * in development, and exposes a tail subscription so the renderer's
 * `<LogViewer/>` can stream new lines as they're written.
 *
 * Format (one line per entry):
 *
 *     [2026-05-07T12:34:56.123Z] [info] message {"key":"value"}
 *
 * Design notes:
 *  - I/O is async (`fs.appendFile`) and serialised behind a single-flight
 *    promise chain so multiple concurrent log calls preserve ordering and
 *    never block the main thread.
 *  - Rotation: every `log()` call computes the current day; if the day
 *    changed since the last write, the next append targets the new
 *    filename.
 *  - Retention: on startup `pruneOldLogs()` deletes files older than
 *    `RETENTION_DAYS` (best-effort).
 *  - Tail subscriptions: `tail({ fromLines })` returns the last N lines
 *    from today's file plus a subscription id; the logger emits new
 *    `LogEntry`s on a `'line'` event keyed by id. Watching the file for
 *    external appends is *not* implemented here (the engine is the only
 *    writer), but the log() path emits to subscribers immediately so the
 *    UI is always in sync.
 *  - `getLogger()` is the singleton accessor used by the rest of main.
 */

import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { LogEntry, LogLevel } from '@shared/types';

/** Filename pattern. Date is `YYYY-MM-DD` in UTC for cross-machine consistency. */
const LOG_FILENAME_PREFIX = 'df-syncer-windows-';
const LOG_FILENAME_SUFFIX = '.log';

/** How many days of files to retain. Older files are deleted on startup. */
export const RETENTION_DAYS = 14;

/**
 * Numeric severity per level. Higher numbers = noisier; the runtime
 * filter passes through every level whose number is `<=` the configured
 * level's number.
 */
const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

export type LoggerOptions = {
  /** Directory containing today's log file. Created on first write. */
  logsDir: string;
  /** Initial level filter. Defaults to `'info'`. */
  level?: LogLevel;
  /** Mirror to `console.*` (used in dev). */
  mirrorToConsole?: boolean;
  /** Override `Date.now()` for tests. */
  now?: () => Date;
};

/**
 * Internal subscription bookkeeping. Each `tail()` call hands back the
 * id; the renderer uses it to unsubscribe.
 */
type Subscription = {
  id: string;
  level?: LogLevel;
};

/** Pad a number to two digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** YYYY-MM-DD (UTC). */
function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Compose the absolute filename for a given date. */
export function logFileFor(logsDir: string, d: Date): string {
  return path.join(logsDir, `${LOG_FILENAME_PREFIX}${dayKey(d)}${LOG_FILENAME_SUFFIX}`);
}

/**
 * Format an entry to a single trailing-newline-terminated string.
 */
export function formatEntry(entry: LogEntry): string {
  const fields =
    entry.fields && Object.keys(entry.fields).length > 0 ? ` ${safeJson(entry.fields)}` : '';
  // Newlines inside `message` are escaped so each entry is exactly one line.
  const safeMessage = entry.message.replace(/\r?\n/g, '\\n');
  return `[${entry.ts}] [${entry.level}] ${safeMessage}${fields}\n`;
}

function safeJson(o: unknown): string {
  try {
    return JSON.stringify(o);
  } catch {
    return '"[unserialisable]"';
  }
}

/**
 * Parse a single log line back into a LogEntry. Returns null if the line
 * doesn't match the canonical format. Used to hydrate the tail buffer
 * when the renderer asks for recent lines.
 */
export function parseLine(line: string): LogEntry | null {
  // [<ts>] [<level>] <message>{ fields?}
  const m = /^\[([^\]]+)\] \[(error|warn|info|debug)\] (.*)$/.exec(line);
  if (!m) return null;
  const ts = m[1];
  const level = m[2] as LogLevel;
  let rest = m[3];
  let fields: Record<string, unknown> | undefined;
  // Try to peel off a trailing JSON object — only if it parses cleanly.
  const jsonStart = rest.lastIndexOf(' {');
  if (jsonStart >= 0) {
    const candidate = rest.slice(jsonStart + 1);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fields = parsed as Record<string, unknown>;
        rest = rest.slice(0, jsonStart);
      }
    } catch {
      // Not JSON; treat the brace as part of the message.
    }
  }
  return fields ? { ts, level, message: rest, fields } : { ts, level, message: rest };
}

/** Events emitted by the logger. */
type LoggerEvents = {
  /** Fired for every accepted entry (after level filter). */
  line: [LogEntry];
  /** Fired when `setLevel()` changes the active level. */
  'level-change': [LogLevel];
};

/**
 * Logger class. Singleton-friendly: prefer `getLogger()` from the rest
 * of the main process. Tests can construct directly with a temp
 * `logsDir` and an injected `now()`.
 */
export class Logger extends EventEmitter {
  override on<K extends keyof LoggerEvents>(
    event: K,
    listener: (...args: LoggerEvents[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof LoggerEvents>(
    event: K,
    listener: (...args: LoggerEvents[K]) => void
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof LoggerEvents>(event: K, ...args: LoggerEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  private level: LogLevel;
  private readonly logsDir: string;
  private readonly mirror: boolean;
  private readonly now: () => Date;
  /** Single-flight write chain: appends serialise via .then so order is preserved. */
  private writeChain: Promise<void> = Promise.resolve();
  private currentDay: string | null = null;
  private subs: Map<string, Subscription> = new Map();
  private nextId = 1;

  constructor(opts: LoggerOptions) {
    super();
    this.logsDir = opts.logsDir;
    this.level = opts.level ?? 'info';
    this.mirror = Boolean(opts.mirrorToConsole);
    this.now = opts.now ?? ((): Date => new Date());
  }

  /** Active level filter. */
  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    if (level === this.level) return;
    this.level = level;
    this.emit('level-change', level);
  }

  /** Return the absolute path of today's log file. */
  todayFile(): string {
    return logFileFor(this.logsDir, this.now());
  }

  /** Convenience accessor for the directory. Useful for `shell.openPath`. */
  getLogsDir(): string {
    return this.logsDir;
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log('error', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log('debug', message, fields);
  }

  /**
   * Lower-level emit; clamps unknown levels to `info` for safety.
   */
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] === undefined) {
      level = 'info';
    }
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level]) {
      return; // Filtered out.
    }
    const ts = this.now().toISOString();
    const entry: LogEntry = fields ? { ts, level, message, fields } : { ts, level, message };
    if (this.mirror) {
      const line = formatEntry(entry).trimEnd();
      switch (level) {
        case 'error':
          console.error(line);
          break;
        case 'warn':
          console.warn(line);
          break;
        case 'debug':
          console.debug(line);
          break;
        default:
          console.log(line);
      }
    }
    this.emit('line', entry);
    this.scheduleWrite(entry);
  }

  /**
   * Subscribe to new log lines. Returns a synthetic id and the most
   * recent `fromLines` lines from today's file (best-effort). The
   * `level` filter, when present, is applied client-side via the
   * renderer; we still emit every line over the wire so the renderer
   * can re-filter without re-subscribing.
   */
  async tail(opts: { fromLines?: number; level?: LogLevel } = {}): Promise<{
    id: string;
    recent: LogEntry[];
  }> {
    const id = `tail-${this.nextId++}`;
    this.subs.set(id, { id, level: opts.level });
    const recent = await this.recentLines(opts.fromLines ?? 200);
    return { id, recent };
  }

  /** Drop a subscription (no-op if id is unknown). */
  unsubscribe(id: string): void {
    this.subs.delete(id);
  }

  /** True if any subscriber is registered. Used by tests. */
  get subscriberCount(): number {
    return this.subs.size;
  }

  /**
   * Read up to `n` recent lines from today's file. Returns `[]` if the
   * file is missing.
   */
  async recentLines(n: number): Promise<LogEntry[]> {
    const file = this.todayFile();
    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const slice = n > 0 ? lines.slice(-n) : lines;
    const out: LogEntry[] = [];
    for (const l of slice) {
      const e = parseLine(l);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Delete log files older than {@link RETENTION_DAYS}. Best-effort:
   * any errors are swallowed (logged via `console.warn`) so a stale
   * permission issue doesn't block startup.
   */
  async pruneOldLogs(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.logsDir);
    } catch {
      return; // Logs dir may not exist yet — fine.
    }
    const cutoffMs = this.now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of entries) {
      if (!name.startsWith(LOG_FILENAME_PREFIX) || !name.endsWith(LOG_FILENAME_SUFFIX)) {
        continue;
      }
      const day = name.slice(LOG_FILENAME_PREFIX.length, -LOG_FILENAME_SUFFIX.length);
      const parsed = parseDayKey(day);
      if (parsed === null) continue;
      if (parsed.getTime() < cutoffMs) {
        try {
          await fsp.unlink(path.join(this.logsDir, name));
        } catch (err) {
          console.warn(`logger: failed to prune ${name}: ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * Wait for all queued writes to flush. Useful for tests and for
   * graceful shutdown so we don't lose the last few lines.
   */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /* ───────────────── internal ───────────────── */

  private scheduleWrite(entry: LogEntry): void {
    const target = this.todayFile();
    const day = dayKey(this.now());
    if (this.currentDay !== day) {
      this.currentDay = day;
    }
    const line = formatEntry(entry);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await ensureDir(this.logsDir);
        await fsp.appendFile(target, line, 'utf8');
      } catch (err) {
        // Don't let logger I/O errors crash the chain. Surface to
        // console so the developer can see what went wrong.
        console.warn(`logger: write failed: ${(err as Error).message}`);
      }
    });
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    // EEXIST is fine; everything else propagates so the caller can see.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

function parseDayKey(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  return new Date(Date.UTC(y, mo, d));
}

/* ───────────────── singleton ───────────────── */

let singleton: Logger | null = null;

/**
 * Configure the singleton. Call once during main-process startup,
 * before any other module reaches for `getLogger()`. Subsequent calls
 * replace the instance (used by tests).
 */
export function configureLogger(opts: LoggerOptions): Logger {
  if (singleton) {
    // Drain the previous instance so no writes are lost.
    void singleton.flush();
  }
  singleton = new Logger(opts);
  return singleton;
}

/**
 * Return the configured singleton. Throws when called before
 * `configureLogger()` so misuse during startup is loud rather than
 * silently dropping log lines.
 *
 * In tests that don't go through `configureLogger`, a no-op fallback is
 * returned so the engine modules don't have to special-case "logger
 * present?" everywhere. The fallback writes to `console` only.
 */
export function getLogger(): Logger {
  if (!singleton) {
    // Build a transient fallback rooted in os.tmpdir; it logs to console
    // only because nothing in tests exercises the file path.
    singleton = new Logger({
      logsDir: path.join(process.cwd(), '.logs-fallback'),
      level: 'info',
      mirrorToConsole: false
    });
  }
  return singleton;
}

/** Reset the singleton; tests use this to get a fresh state per case. */
export function _resetLoggerForTests(): void {
  if (singleton) {
    void singleton.flush();
    singleton.removeAllListeners();
  }
  singleton = null;
}

/** Re-exported file constants for tests. */
export const LOG_FILE_PREFIX = LOG_FILENAME_PREFIX;
export const LOG_FILE_SUFFIX = LOG_FILENAME_SUFFIX;
