/**
 * Cloud-side advisory lock.
 *
 * The lock file lives at `<cloudFolder>/df-syncer-windows/lock.json` and
 * contains a single owner record. Acquisition is `O_CREAT | O_EXCL`
 * (Node `flag: 'wx'`), so two processes — even on different machines
 * sharing the same cloud folder — cannot both acquire simultaneously.
 *
 * This is *advisory*: nothing in the filesystem stops a third party
 * from blowing it away or ignoring it. Within df-syncer-windows it is treated
 * as the single source of truth for "is somebody syncing right now."
 *
 * Stale locks (age > `staleMinutes`, default 10) belonging to *this*
 * machine can be cleared via the `onStaleSelfLock` callback; locks
 * belonging to a *different* machine are never auto-cleared.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Owner record persisted inside `lock.json`.
 */
export type LockOwner = {
  machineId: string;
  pid: number;
  /** ISO-8601. Compared to `Date.now()` for staleness. */
  acquiredAt: string;
  hostname: string;
};

/**
 * Options accepted by {@link acquireCloudLock} and {@link withCloudLock}.
 */
export type AcquireLockOptions = {
  /**
   * How long, in minutes, an existing lock must be untouched before it
   * is eligible for stale-clear. Defaults to 10.
   */
  staleMinutes?: number;
  /**
   * Invoked when the existing lock belongs to *us* (same `machineId`)
   * AND its age exceeds `staleMinutes`. The callback is the executor's
   * chance to ask the user "looks like the previous sync didn't finish
   * — clear and retry?" and return their answer.
   *
   * If the callback resolves to `true`, the existing lock is overwritten
   * and acquisition succeeds. If `false` (or the callback is omitted),
   * acquisition fails with {@link LockHeldError}.
   */
  onStaleSelfLock?: (existing: LockOwner) => Promise<boolean>;
};

/**
 * Thrown by {@link acquireCloudLock} when another machine — or this
 * machine without auto-clear permission — already holds the lock.
 *
 * The `owner` field carries the existing record so callers can render
 * a useful "held by `<hostname>` since `<time>`" message.
 */
export class LockHeldError extends Error {
  public readonly owner: LockOwner;

  constructor(owner: LockOwner) {
    super(
      `Cloud lock already held by ${owner.machineId} (${owner.hostname}, pid ${owner.pid}) ` +
        `since ${owner.acquiredAt}.`
    );
    this.name = 'LockHeldError';
    this.owner = owner;
  }
}

/**
 * Try to acquire the cloud-side lock.
 *
 * Behaviour:
 * - If no `lock.json` exists, write ours via `flag: 'wx'` and return
 *   the new {@link LockOwner}.
 * - If `lock.json` exists and the existing owner is *another* machine,
 *   throw {@link LockHeldError} unconditionally.
 * - If `lock.json` exists, the existing owner is *us*, and the lock is
 *   newer than `staleMinutes`, throw {@link LockHeldError}. (Two
 *   df-syncer-windows instances on the same machine should not race.)
 * - If `lock.json` exists, the existing owner is *us*, and the lock is
 *   older than `staleMinutes`, invoke `onStaleSelfLock`. If it
 *   resolves true, atomically overwrite and return success; otherwise
 *   throw {@link LockHeldError}.
 *
 * The directory `<cloudFolder>/df-syncer-windows/` is created if missing.
 */
export async function acquireCloudLock(
  cloudFolder: string,
  machineId: string,
  opts: AcquireLockOptions = {}
): Promise<LockOwner> {
  const staleMinutes = opts.staleMinutes ?? 10;
  const lockPath = getLockPath(cloudFolder);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const owner = buildOwner(machineId);
  const payload = serializeOwner(owner);

  try {
    await fs.writeFile(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
    return owner;
  } catch (err) {
    if (!isExistError(err)) throw err;
  }

  // The lock already exists. Read it and decide what to do.
  const existing = await readExistingLock(lockPath);

  // Case 1: held by another machine. Never auto-clear.
  if (existing.machineId !== machineId) {
    throw new LockHeldError(existing);
  }

  // Case 2: held by us. Stale?
  const ageMs = Date.now() - new Date(existing.acquiredAt).getTime();
  const ageMinutes = ageMs / 60000;
  const isStale = Number.isFinite(ageMinutes) && ageMinutes > staleMinutes;

  if (!isStale) {
    throw new LockHeldError(existing);
  }

  // Case 3: stale self-lock. Ask the caller.
  const userApproved = opts.onStaleSelfLock ? await opts.onStaleSelfLock(existing) : false;
  if (!userApproved) {
    throw new LockHeldError(existing);
  }

  // Overwrite. We use plain `writeFile` (no flag), since we already
  // know the file exists and the user said it's fine to clobber.
  await fs.writeFile(lockPath, payload, { encoding: 'utf8' });
  return owner;
}

/**
 * Release the lock if and only if it is held by `machineId`. A lock
 * belonging to another machine is left in place (and silently — this
 * function never throws on "not ours"; callers shouldn't have to wrap
 * it in a try/catch in the success path of `withCloudLock`).
 *
 * Missing lock file is also a no-op.
 */
export async function releaseCloudLock(cloudFolder: string, machineId: string): Promise<void> {
  const lockPath = getLockPath(cloudFolder);
  let existing: LockOwner;
  try {
    existing = await readExistingLock(lockPath);
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
  if (existing.machineId !== machineId) {
    // Not ours — refuse to delete. We don't surface this as a thrown
    // error because the executor's `finally` block calls release
    // unconditionally; the only sensible behaviour is to leave the
    // other machine's lock alone.
    return;
  }
  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
}

/**
 * Acquire the lock, run `fn`, and release in a `finally`. The lock is
 * released whether `fn` resolves or throws; `acquireCloudLock` errors
 * propagate without `fn` being called.
 */
export async function withCloudLock<T>(
  cloudFolder: string,
  machineId: string,
  opts: AcquireLockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const owner = await acquireCloudLock(cloudFolder, machineId, opts);
  try {
    return await fn();
  } finally {
    await releaseCloudLock(cloudFolder, owner.machineId);
  }
}

/**
 * Absolute path of the lock file inside `<cloudFolder>`.
 * Exported so tests and callers (e.g. integration tests in Phase 6)
 * can probe it without duplicating the constant.
 */
export function getLockPath(cloudFolder: string): string {
  return path.join(cloudFolder, 'df-syncer-windows', 'lock.json');
}

function buildOwner(machineId: string): LockOwner {
  return {
    machineId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    hostname: safeHostname()
  };
}

function safeHostname(): string {
  try {
    return os.hostname() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function serializeOwner(owner: LockOwner): string {
  return JSON.stringify(owner, null, 2) + '\n';
}

async function readExistingLock(lockPath: string): Promise<LockOwner> {
  const raw = await fs.readFile(lockPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedLockError(lockPath);
  }
  if (!isLockOwner(parsed)) {
    throw new MalformedLockError(lockPath);
  }
  return parsed;
}

function isLockOwner(v: unknown): v is LockOwner {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.machineId === 'string' &&
    typeof o.pid === 'number' &&
    typeof o.acquiredAt === 'string' &&
    typeof o.hostname === 'string'
  );
}

/**
 * Thrown internally if `lock.json` exists but cannot be parsed as a
 * {@link LockOwner}. Surfaced as a regular `Error` to the caller so
 * the UI can render "remove and retry" guidance.
 */
export class MalformedLockError extends Error {
  public readonly lockPath: string;

  constructor(lockPath: string) {
    super(`Lock file at ${lockPath} is malformed and cannot be parsed.`);
    this.name = 'MalformedLockError';
    this.lockPath = lockPath;
  }
}

function isExistError(err: unknown): boolean {
  return isNodeErrnoException(err) && err.code === 'EEXIST';
}

function isNotFoundError(err: unknown): boolean {
  return isNodeErrnoException(err) && err.code === 'ENOENT';
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
