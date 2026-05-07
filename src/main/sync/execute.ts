/**
 * Sync executor.
 *
 * `applyPlan` is the single entry point that composes every primitive
 * built in earlier phases — scan, manifest, diff, materializePlan,
 * backup, atomic, lock — into one end-to-end sync operation. It owns
 * the executor state machine documented below and is the only place in
 * the codebase that writes the cloud manifest, the local last-base
 * manifest, or appends to history.
 *
 * State machine (see also `phase-6.md`):
 *
 *     ┌───────┐
 *     │ idle  │
 *     └───┬───┘
 *         │ applyPlan() called
 *         ▼
 *     ┌───────────┐         ┌──────────────────────┐
 *     │ pre-check ├────────▶│ refused (return ok=false) │
 *     └─────┬─────┘         └──────────────────────┘
 *           │ ok
 *           ▼
 *     ┌──────┐ ▲ release-lock (always)
 *     │ lock │◀┘ on any error after this point
 *     └──┬───┘
 *        ▼
 *     ┌──────────────┐
 *     │ backup-begin │
 *     └──────┬───────┘
 *            ▼
 *     ┌──────┐    ┌────────────┐
 *     │ apply├───▶│ cancelled  │ (AbortSignal)
 *     └──┬───┘    └─────┬──────┘
 *        ▼              ▼
 *     ┌──────────────┐  ┌─────────────────────────┐
 *     │ manifest-    │  │ finalize backup (always)│
 *     │ rebuild      │  │ release lock (always)   │
 *     └──────┬───────┘  │ DO NOT write manifests  │
 *            ▼          └─────────────────────────┘
 *     ┌────────────────┐
 *     │ manifest-write │
 *     └──────┬─────────┘
 *            ▼
 *     ┌──────────────────┐
 *     │ backup-finalize  │
 *     └──────┬───────────┘
 *            ▼
 *     ┌───────┐
 *     │ prune │
 *     └──┬────┘
 *        ▼
 *     ┌───────────────┐
 *     │ history-write │
 *     └──────┬────────┘
 *            ▼
 *     ┌──────┐
 *     │ done │ (return ok=true)
 *     └──────┘
 *
 * Invariants:
 * - The cloud lock is acquired *after* pre-check, released *always* in
 *   `finally` (even on throw or abort). It must never leak.
 * - The backup session is finalised on every code path past
 *   `backup-begin`, even on error, so any displaced bytes are
 *   recoverable.
 * - On any error after `backup-begin`, neither the cloud manifest nor
 *   the local last-base manifest is written. (Re-running `applyPlan`
 *   on a freshly-built plan recovers the user's intent.)
 * - Idempotent: re-running with the same plan after success sees no
 *   changes (post-apply scan equals the just-written manifest), so the
 *   empty-plan early exit triggers and nothing is rewritten.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type {
  AppConfig,
  FileEntry,
  Manifest,
  SyncPhase,
  SyncPlan,
  SyncPlanItem,
  SyncProgress,
  SyncResult,
  SyncResultErrorKind
} from '@shared/types';
import { writeHistoryEntry } from '../history';
import { atomicCopy, atomicDelete } from './atomic';
import { beginBackup, buildTimestamp, pruneBackups } from './backup';
import { isConflict } from './diff';
import { buildManifestFromEntries, writeCloudManifest, writeLastBaseManifest } from './manifest';
import { scanFolder } from './scan';
import {
  acquireCloudLock,
  LockHeldError,
  type LockOwner,
  releaseCloudLock,
  type AcquireLockOptions
} from './lock';

/**
 * Subfolders of the DF data root that the executor recognises. Mirrors
 * `AppConfig.enabledFolders` keys.
 */
const DF_SUBFOLDERS = ['data', 'mods', 'prefs', 'save'] as const;

/**
 * Free-space safety multiplier per §6.5 of the implementation plan.
 * Refuse to push if cloud free bytes < planned bytes × this.
 */
export const FREE_SPACE_MULTIPLIER = 1.2;

/* ───────────────── typed errors ───────────────── */

/**
 * Pre-check refusal — DF is running, lock is held by another machine,
 * cloud is full, etc. Carries a discriminator the UI can branch on.
 */
export class SyncRefusedError extends Error {
  public readonly kind: SyncResultErrorKind;
  /** Optional structured payload (e.g. lock owner, free bytes). */
  public readonly detail?: unknown;
  constructor(kind: SyncResultErrorKind, message?: string, detail?: unknown) {
    super(message ?? defaultRefusedMessage(kind));
    this.name = 'SyncRefusedError';
    this.kind = kind;
    this.detail = detail;
  }
}

function defaultRefusedMessage(kind: SyncResultErrorKind): string {
  switch (kind) {
    case 'df-running':
      return 'Refusing to sync while Dwarf Fortress is running.';
    case 'insufficient-cloud-space':
      return 'Cloud folder has insufficient free space for the planned sync.';
    case 'lock-held':
      return 'Cloud sync is already in progress on another machine.';
    case 'no-config':
      return 'Sync configuration is missing required fields (cloud or game folder).';
    case 'unresolved-conflicts':
      return 'Plan still contains unresolved conflicts; resolve via the UI before applying.';
    default:
      return `Sync refused: ${kind}.`;
  }
}

/**
 * Thrown by {@link applyPlan} when another `applyPlan` is already
 * mid-flight in the same process. Single-flight guard protects the
 * cloud manifest write from interleaved updates.
 */
export class SyncInProgressError extends Error {
  constructor() {
    super('A sync is already in progress.');
    this.name = 'SyncInProgressError';
  }
}

/**
 * Thrown when the post-apply scan disagrees with what the executor
 * thought it had just written — e.g. an `atomicCopy` succeeded but the
 * destination's sha1 doesn't match the source. This is the safety
 * checksum that catches silent corruption.
 */
export class SyncIntegrityError extends Error {
  public readonly mismatchedRels: string[];
  constructor(mismatchedRels: string[]) {
    super(
      `Post-apply integrity check failed: ${mismatchedRels.length} file(s) differ between local and cloud after sync.`
    );
    this.name = 'SyncIntegrityError';
    this.mismatchedRels = mismatchedRels;
  }
}

/**
 * Thrown when the caller's `AbortSignal` fires mid-apply. The lock and
 * backup session are still released/finalized in `applyPlan`'s
 * `finally`; the manifest is *not* written.
 */
export class SyncCancelledError extends Error {
  constructor() {
    super('Sync was cancelled.');
    this.name = 'SyncCancelledError';
  }
}

/* ───────────────── single-flight guard ───────────────── */

/** Module-level lock so two `applyPlan` calls in the same process can't race. */
let inProgress = false;
/** Snapshot exposed via {@link getSyncStatus} for `sync:getStatus` IPC. */
let currentStatus: {
  inProgress: boolean;
  planId?: string;
  startedAt?: string;
  phase?: SyncPhase;
  total?: number;
  completed?: number;
  lastError?: string;
} = { inProgress: false };
/**
 * The `AbortController` for the in-flight sync, if any. The IPC
 * `sync:cancel` handler aborts via this.
 */
let currentAbort: AbortController | null = null;

/**
 * Snapshot the current sync status. Mirrors `SyncStatus` from
 * `@shared/types` for the IPC handler.
 */
export function getSyncStatus(): {
  inProgress: boolean;
  currentPlanId?: string;
  startedAt?: string;
  currentPhase?: SyncPhase;
  plannedItems?: number;
  completedItems?: number;
  lastError?: string;
} {
  return {
    inProgress: currentStatus.inProgress,
    currentPlanId: currentStatus.planId,
    startedAt: currentStatus.startedAt,
    currentPhase: currentStatus.phase,
    plannedItems: currentStatus.total,
    completedItems: currentStatus.completed,
    lastError: currentStatus.lastError
  };
}

/**
 * Trigger cancellation of the in-flight `applyPlan`, if any. Returns
 * `true` if a sync was running and has been signalled to abort,
 * `false` otherwise. The actual unwind happens cooperatively inside
 * `applyPlan`'s loop.
 */
export function cancelInProgressSync(): boolean {
  if (!inProgress || !currentAbort) return false;
  currentAbort.abort();
  return true;
}

/* ───────────────── executor context ───────────────── */

/**
 * Caller-supplied dependencies and options for {@link applyPlan}. Each
 * field is documented in §6.5/§6.6 of the implementation plan; see the
 * Phase 6 result file for end-to-end usage.
 */
export interface ApplyPlanContext {
  config: AppConfig;
  dryRun: boolean;
  machineId: string;
  cloudFolder: string;
  gameFolder: string;
  /** `app.getPath('userData')` in production; a temp dir in tests. */
  userDataDir: string;
  /** `%LOCALAPPDATA%\df-syncer-windows\backups` in production. */
  backupRootDir: string;
  onProgress?: (p: SyncProgress) => void;
  onStaleSelfLock?: (existing: LockOwner) => Promise<boolean>;
  signal: AbortSignal;
  /** Pre-checked by caller. Omit (or pass `false`) when DF is not running. */
  dfRunning?: boolean;
  /**
   * Override for free-space probe. Production calls
   * `validateCloudFolder(cloudFolder).freeBytes` from `paths.ts`; tests
   * inject a fixed value to drive the precheck.
   */
  freeBytesProbe?: (cloudFolder: string) => Promise<number | undefined>;
  /**
   * Override for `Date.now()` used in pre-checks and backup timestamps.
   * Tests pass a fixed clock for deterministic backup folder names.
   */
  clock?: () => Date;
}

/* ───────────────── main entry point ───────────────── */

/**
 * Apply a `SyncPlan` end-to-end. Composes every Phase 2-5 primitive and
 * persists the new state. See the state-machine ASCII at the top of this
 * file for the full sequence and invariants.
 *
 * The function is responsible for:
 * - Pre-checks: DF-running gate, free-space, no remaining conflicts,
 *   single-flight guard.
 * - Cloud lock acquisition (released always in `finally`).
 * - Backup session lifecycle (finalised always; partials recoverable).
 * - Atomic apply of every `applied: true` item per ordering rules.
 * - Post-apply re-scan, manifest commit (cloud + local), backup prune,
 *   history append.
 *
 * Returns a `SyncResult` whose `ok` field discriminates success vs.
 * a refused/aborted/failed run. Successful runs always have backup
 * (if any displaced bytes), manifests, and a history entry persisted.
 * Failed runs have backup but **no** manifest write.
 */
export async function applyPlan(plan: SyncPlan, ctx: ApplyPlanContext): Promise<SyncResult> {
  // -- single-flight guard ---------------------------------------------
  if (inProgress) {
    throw new SyncInProgressError();
  }
  inProgress = true;
  const abort = new AbortController();
  currentAbort = abort;
  // Forward caller's signal to our internal abort so we can cancel
  // child operations (scans) without exposing the user's signal to
  // every primitive.
  if (ctx.signal.aborted) {
    abort.abort();
  } else {
    ctx.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }

  const startedAt = (ctx.clock?.() ?? new Date()).toISOString();
  const timestamp = buildTimestamp(ctx.clock?.());
  currentStatus = {
    inProgress: true,
    planId: plan.id,
    startedAt,
    phase: 'pre-check',
    total: plan.items.filter((i) => i.applied && !isConflict(i.kind)).length,
    completed: 0
  };
  emit(ctx, { phase: 'pre-check', index: 0, total: currentStatus.total ?? 0 });

  try {
    // -- pre-checks (no side effects yet) ------------------------------

    // §6.5: DF running ⇒ refuse.
    if (ctx.dfRunning) {
      throw new SyncRefusedError('df-running');
    }

    // Config sanity.
    if (!ctx.cloudFolder || !ctx.gameFolder) {
      throw new SyncRefusedError('no-config');
    }

    // Unresolved conflicts ⇒ refuse. The caller is supposed to have run
    // `materializePlan` and converted every conflict into a concrete
    // push/pull (or suppressed it via `applied: false` after a user
    // chose to skip). Items still tagged `conflict-*` AND `applied:
    // true` here mean the caller forgot to resolve them — we won't
    // touch the cloud.
    const blockingConflicts = plan.items.filter((i) => isConflict(i.kind) && i.applied);
    if (blockingConflicts.length > 0) {
      return buildResult(plan, ctx, startedAt, timestamp, {
        ok: false,
        errorKind: 'unresolved-conflicts',
        error: `${blockingConflicts.length} conflict(s) remain unresolved`,
        applied: 0,
        skipped: plan.items.length,
        bytesWritten: 0,
        backupCount: 0,
        conflicts: blockingConflicts
      });
    }

    // Empty plan ⇒ no-op early exit. Per §6.5: do not write the cloud
    // manifest (it's already correct).
    const appliedItems = plan.items.filter((i) => i.applied && !isConflict(i.kind));
    if (appliedItems.length === 0) {
      return buildResult(plan, ctx, startedAt, timestamp, {
        ok: true,
        applied: 0,
        skipped: plan.items.length,
        bytesWritten: 0,
        backupCount: 0,
        conflicts: []
      });
    }

    // Free-space precheck against planned push bytes × multiplier.
    if (!ctx.dryRun) {
      const plannedPushBytes = appliedItems
        .filter((i) => i.kind === 'push')
        .reduce((sum, i) => sum + i.bytes, 0);
      if (plannedPushBytes > 0 && ctx.freeBytesProbe) {
        const free = await ctx.freeBytesProbe(ctx.cloudFolder);
        if (free !== undefined && free < plannedPushBytes * FREE_SPACE_MULTIPLIER) {
          throw new SyncRefusedError(
            'insufficient-cloud-space',
            `Cloud free ${free} bytes < required ${Math.ceil(plannedPushBytes * FREE_SPACE_MULTIPLIER)} bytes (planned + 20% headroom).`,
            { freeBytes: free, requiredBytes: plannedPushBytes }
          );
        }
      }
    }

    // Dry-run path: emit the progress events but never touch disk and
    // never take the lock.
    if (ctx.dryRun) {
      return await runDryRun(plan, appliedItems, ctx, startedAt, timestamp);
    }

    // -- lock acquire --------------------------------------------------
    setPhase(ctx, 'lock', 0, currentStatus.total ?? 0);
    const lockOpts: AcquireLockOptions = {
      staleMinutes: 10,
      ...(ctx.onStaleSelfLock ? { onStaleSelfLock: ctx.onStaleSelfLock } : {})
    };
    let lockOwner: LockOwner;
    try {
      lockOwner = await acquireCloudLock(ctx.cloudFolder, ctx.machineId, lockOpts);
    } catch (err) {
      if (err instanceof LockHeldError) {
        throw new SyncRefusedError('lock-held', err.message, err.owner);
      }
      throw err;
    }

    // From here on the lock is held; release in `finally`.
    let result: SyncResult;
    try {
      result = await runWithLock(plan, appliedItems, ctx, startedAt, timestamp, abort.signal);
    } finally {
      try {
        await releaseCloudLock(ctx.cloudFolder, lockOwner.machineId);
      } catch (err) {
        // Lock release failures are logged but not propagated — the
        // outer `finally` already ran any cleanup, and the cloud lock
        // file will be reclaimable as a stale self-lock on the next
        // run.
        console.warn(`execute: lock release failed: ${(err as Error).message}`);
      }
    }
    return result;
  } catch (err) {
    return handleTopLevelError(err, plan, ctx, startedAt, timestamp);
  } finally {
    inProgress = false;
    currentAbort = null;
    currentStatus = { inProgress: false };
  }
}

/* ───────────────── locked region ───────────────── */

/**
 * The work performed while the cloud lock is held. Split out so the
 * lock-release `finally` is unmistakable in {@link applyPlan}.
 */
async function runWithLock(
  plan: SyncPlan,
  appliedItems: SyncPlanItem[],
  ctx: ApplyPlanContext,
  startedAt: string,
  timestamp: string,
  signal: AbortSignal
): Promise<SyncResult> {
  // -- backup-begin ----------------------------------------------------
  setPhase(ctx, 'backup-begin', 0, appliedItems.length);
  const session = await beginBackup(ctx.backupRootDir, timestamp);

  let backupResult: { archivePath?: string; dirPath?: string } = {};
  let bytesWritten = 0;
  let appliedCount = 0;
  let manifestsWritten = false;

  try {
    // -- apply ---------------------------------------------------------
    setPhase(ctx, 'apply', 0, appliedItems.length);

    // Order: pulls before pushes (defensive — should be mutually
    // exclusive per rel) and copies before deletes within each side.
    const ordered = orderItems(appliedItems);

    let i = 0;
    for (const item of ordered) {
      throwIfAborted(signal);
      emit(ctx, {
        phase: 'apply',
        index: i,
        total: ordered.length,
        currentRel: item.rel
      });
      currentStatus = { ...currentStatus, completed: i, phase: 'apply' };

      bytesWritten += await applyItem(item, ctx, session);
      appliedCount += 1;
      i += 1;
    }
    emit(ctx, { phase: 'apply', index: ordered.length, total: ordered.length });
    currentStatus = { ...currentStatus, completed: ordered.length };

    // -- manifest-rebuild ---------------------------------------------
    setPhase(ctx, 'manifest-rebuild', ordered.length, ordered.length);
    throwIfAborted(signal);

    const localAfter = await scanLocal(ctx, signal);
    const cloudAfter = await scanCloudMirror(ctx, signal);

    // Integrity: every rel that exists on both sides must agree by sha1
    // and size. Files that only exist on one side are out-of-scope (not
    // in the plan or excluded by config).
    const mismatched = diffEntriesShaSize(localAfter, cloudAfter);
    if (mismatched.length > 0) {
      throw new SyncIntegrityError(mismatched);
    }

    const newCloudManifest: Manifest = buildManifestFromEntries(cloudAfter, ctx.machineId);

    // -- manifest-write ------------------------------------------------
    setPhase(ctx, 'manifest-write', ordered.length, ordered.length);
    throwIfAborted(signal);
    await writeCloudManifest(ctx.cloudFolder, newCloudManifest);
    await writeLastBaseManifest(ctx.userDataDir, newCloudManifest);
    manifestsWritten = true;

    // -- backup-finalize ----------------------------------------------
    setPhase(ctx, 'backup-finalize', ordered.length, ordered.length);
    backupResult = await session.finalize({ compress: ctx.config.backup.compress });

    // -- prune ---------------------------------------------------------
    setPhase(ctx, 'prune', ordered.length, ordered.length);
    await pruneBackups(ctx.backupRootDir, ctx.config.backup.keepLastN);

    // -- history-write -------------------------------------------------
    setPhase(ctx, 'history-write', ordered.length, ordered.length);
    const successResult = buildResult(plan, ctx, startedAt, timestamp, {
      ok: true,
      applied: appliedCount,
      skipped: plan.items.length - appliedCount,
      bytesWritten,
      backupCount: session.entries.size,
      conflicts: [],
      backupArchivePath: backupResult.archivePath,
      backupDirPath: backupResult.dirPath
    });
    await persistHistory(ctx, successResult);

    setPhase(ctx, 'done', ordered.length, ordered.length);
    return successResult;
  } catch (err) {
    // Mid-apply error path: finalize the backup so partials are still
    // recoverable, do NOT touch manifests.
    if (!manifestsWritten) {
      try {
        backupResult = await session.finalize({ compress: ctx.config.backup.compress });
      } catch (finalizeErr) {
        // Don't let a finalize failure mask the original error; just
        // log and continue propagating.
        console.warn(
          `execute: backup finalize failed during error unwind: ${(finalizeErr as Error).message}`
        );
      }
    }
    // Persist a failure history entry so the UI can show "rolled back;
    // recoverable from backup at: ...".
    const errorKind = classifyError(err);
    const failureResult = buildResult(plan, ctx, startedAt, timestamp, {
      ok: false,
      errorKind,
      error: (err as Error).message,
      applied: appliedCount,
      skipped: plan.items.length - appliedCount,
      bytesWritten,
      backupCount: session.entries.size,
      conflicts: [],
      backupArchivePath: backupResult.archivePath,
      backupDirPath: backupResult.dirPath
    });
    try {
      await persistHistory(ctx, failureResult);
    } catch (historyErr) {
      console.warn(`execute: history persist failed: ${(historyErr as Error).message}`);
    }
    setPhase(ctx, 'error', appliedCount, appliedItems.length, (err as Error).message);
    if (err instanceof SyncCancelledError) {
      return failureResult;
    }
    if (err instanceof SyncIntegrityError) {
      return failureResult;
    }
    if (err instanceof SyncRefusedError) {
      return failureResult;
    }
    // Unknown error: still return the failure result rather than
    // throwing, so the caller (IPC handler) gets a structured result.
    return failureResult;
  }
}

/* ───────────────── apply-step helpers ───────────────── */

/**
 * Apply a single plan item: snapshot the displaced file (if any) into
 * the backup, then run the atomic primitive. Returns the bytes written
 * to the destination side (used to populate `SyncResult.bytesWritten`).
 */
async function applyItem(
  item: SyncPlanItem,
  ctx: ApplyPlanContext,
  session: import('./backup').BackupSession
): Promise<number> {
  const localAbs = path.join(ctx.gameFolder, ...item.rel.split('/'));
  const cloudAbs = path.join(ctx.cloudFolder, 'df-syncer-windows', 'mirror', ...item.rel.split('/'));
  switch (item.kind) {
    case 'push': {
      // Push: cloud-side file (if any) is displaced. Back it up first.
      if (await pathExists(cloudAbs)) {
        await session.snapshot(cloudAbs, item.rel);
      }
      await ensureDir(path.dirname(cloudAbs));
      await atomicCopy(localAbs, cloudAbs);
      return item.bytes;
    }
    case 'push-delete': {
      // Cloud loses the file; back it up first.
      if (await pathExists(cloudAbs)) {
        await session.snapshot(cloudAbs, item.rel);
      }
      await atomicDelete(cloudAbs);
      return 0;
    }
    case 'pull': {
      // Local-side file (if any) is displaced. Back it up first.
      if (await pathExists(localAbs)) {
        await session.snapshot(localAbs, item.rel);
      }
      await ensureDir(path.dirname(localAbs));
      await atomicCopy(cloudAbs, localAbs);
      return item.bytes;
    }
    case 'pull-delete': {
      if (await pathExists(localAbs)) {
        await session.snapshot(localAbs, item.rel);
      }
      await atomicDelete(localAbs);
      return 0;
    }
    default:
      // Conflict items are filtered upstream; ignore defensively.
      return 0;
  }
}

/**
 * Order items so that:
 * 1. Pulls run before pushes (defensive — should be mutually exclusive).
 * 2. Copies before deletes within each side.
 *
 * This is the §6.5 "process deletes after copies" guard — cheap
 * insurance against the rare case where a copy reads a just-deleted
 * file.
 */
function orderItems(items: SyncPlanItem[]): SyncPlanItem[] {
  const rank = (kind: SyncPlanItem['kind']): number => {
    switch (kind) {
      case 'pull':
        return 0;
      case 'push':
        return 1;
      case 'pull-delete':
        return 2;
      case 'push-delete':
        return 3;
      default:
        return 4;
    }
  };
  return [...items].sort((a, b) => {
    const r = rank(a.kind) - rank(b.kind);
    if (r !== 0) return r;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
}

/* ───────────────── scan helpers ───────────────── */

/**
 * Scan the local game folder, producing entries keyed by `<sub>/<...>`
 * (matching the cloud-side mirror layout). Only enabled subfolders are
 * walked.
 */
async function scanLocal(ctx: ApplyPlanContext, signal: AbortSignal): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const sub of DF_SUBFOLDERS) {
    if (!ctx.config.enabledFolders[sub]) continue;
    const root = path.join(ctx.gameFolder, sub);
    try {
      const entries = await scanFolder(root, {
        excludeGlobs: ctx.config.excludeGlobs,
        signal
      });
      for (const e of entries) {
        out.push({ ...e, rel: `${sub}/${e.rel}` });
      }
    } catch (err) {
      if ((err as Error).message === 'aborted') throw new SyncCancelledError();
      // Folder may not exist; skip silently.
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * Scan `<cloudFolder>/df-syncer-windows/mirror/`. Empty if the mirror dir
 * doesn't exist yet (first push).
 */
async function scanCloudMirror(ctx: ApplyPlanContext, signal: AbortSignal): Promise<FileEntry[]> {
  const root = path.join(ctx.cloudFolder, 'df-syncer-windows', 'mirror');
  try {
    const entries = await scanFolder(root, {
      excludeGlobs: ctx.config.excludeGlobs,
      signal
    });
    return entries;
  } catch (err) {
    if ((err as Error).message === 'aborted') throw new SyncCancelledError();
    return [];
  }
}

/**
 * Compare two sorted entry lists by sha1+size. Returns the rels that
 * exist on both sides but disagree. Files that exist on only one side
 * are not flagged (they're either out-of-scope or covered by a
 * different plan item).
 */
function diffEntriesShaSize(a: FileEntry[], b: FileEntry[]): string[] {
  const aMap = new Map(a.map((e) => [e.rel, e]));
  const mismatched: string[] = [];
  for (const eb of b) {
    const ea = aMap.get(eb.rel);
    if (!ea) continue;
    if (ea.sha1 !== eb.sha1 || ea.size !== eb.size) {
      mismatched.push(eb.rel);
    }
  }
  return mismatched;
}

/* ───────────────── dry-run path ───────────────── */

/**
 * Dry-run: emit progress events for every applied item, but perform no
 * filesystem writes. The lock is *not* acquired (read-only operation).
 * No backup/manifest/history writes either.
 */
async function runDryRun(
  plan: SyncPlan,
  appliedItems: SyncPlanItem[],
  ctx: ApplyPlanContext,
  startedAt: string,
  timestamp: string
): Promise<SyncResult> {
  const ordered = orderItems(appliedItems);
  setPhase(ctx, 'apply', 0, ordered.length);
  for (let i = 0; i < ordered.length; i += 1) {
    if (ctx.signal.aborted) {
      throw new SyncCancelledError();
    }
    emit(ctx, {
      phase: 'apply',
      index: i,
      total: ordered.length,
      currentRel: ordered[i].rel
    });
  }
  setPhase(ctx, 'done', ordered.length, ordered.length);
  return buildResult(plan, ctx, startedAt, timestamp, {
    ok: true,
    applied: ordered.length,
    skipped: plan.items.length - ordered.length,
    bytesWritten: 0,
    backupCount: 0,
    conflicts: []
  });
}

/* ───────────────── result + history helpers ───────────────── */

/**
 * Persist a `SyncResult` to history. `history.ts` does not import the
 * executor, so this static import does not introduce a cycle.
 */
async function persistHistory(ctx: ApplyPlanContext, result: SyncResult): Promise<void> {
  await writeHistoryEntry(ctx.userDataDir, {
    timestamp: result.backupTimestamp ?? result.startedAt,
    direction: result.direction,
    result
  });
}

/**
 * Construct a `SyncResult` from the executor's running state. Centralised
 * so success and failure paths produce uniformly-shaped objects.
 */
function buildResult(
  plan: SyncPlan,
  ctx: ApplyPlanContext,
  startedAt: string,
  timestamp: string,
  parts: {
    ok: boolean;
    applied: number;
    skipped: number;
    bytesWritten: number;
    backupCount: number;
    conflicts: SyncPlanItem[];
    errorKind?: SyncResultErrorKind;
    error?: string;
    backupArchivePath?: string;
    backupDirPath?: string;
  }
): SyncResult {
  const completedAt = (ctx.clock?.() ?? new Date()).toISOString();
  const result: SyncResult = {
    planId: plan.id,
    startedAt,
    completedAt,
    direction: plan.direction,
    dryRun: ctx.dryRun,
    ok: parts.ok,
    applied: parts.applied,
    skipped: parts.skipped,
    bytesWritten: parts.bytesWritten,
    backupCount: parts.backupCount,
    conflicts: parts.conflicts
  };
  if (parts.backupCount > 0) {
    result.backupTimestamp = timestamp;
  }
  if (parts.backupArchivePath) result.backupArchivePath = parts.backupArchivePath;
  if (parts.backupDirPath) result.backupDirPath = parts.backupDirPath;
  if (parts.errorKind) result.errorKind = parts.errorKind;
  if (parts.error) result.error = parts.error;
  return result;
}

/**
 * Top-level error handler: errors that escape the locked region (or
 * happen before lock acquisition). Single-flight + lock-leak errors are
 * thrown (callers should treat them as exceptional); structured refusals
 * become a `SyncResult { ok: false }`.
 */
function handleTopLevelError(
  err: unknown,
  plan: SyncPlan,
  ctx: ApplyPlanContext,
  startedAt: string,
  timestamp: string
): SyncResult {
  // Single-flight and integrity errors propagate. (Single-flight is
  // checked before this `try` so it would already have rethrown; this
  // is just for clarity.)
  if (err instanceof SyncInProgressError) {
    throw err;
  }

  // Refused (df-running, free-space, lock-held, no-config,
  // unresolved-conflicts) → structured result.
  if (err instanceof SyncRefusedError) {
    return buildResult(plan, ctx, startedAt, timestamp, {
      ok: false,
      errorKind: err.kind,
      error: err.message,
      applied: 0,
      skipped: plan.items.length,
      bytesWritten: 0,
      backupCount: 0,
      conflicts: []
    });
  }
  if (err instanceof SyncCancelledError) {
    return buildResult(plan, ctx, startedAt, timestamp, {
      ok: false,
      errorKind: 'cancelled',
      error: err.message,
      applied: 0,
      skipped: plan.items.length,
      bytesWritten: 0,
      backupCount: 0,
      conflicts: []
    });
  }
  if (err instanceof SyncIntegrityError) {
    return buildResult(plan, ctx, startedAt, timestamp, {
      ok: false,
      errorKind: 'integrity',
      error: err.message,
      applied: 0,
      skipped: plan.items.length,
      bytesWritten: 0,
      backupCount: 0,
      conflicts: []
    });
  }
  // Unknown error: still surface as a structured result rather than
  // throwing, so callers don't have to wrap every IPC call in a
  // try/catch.
  return buildResult(plan, ctx, startedAt, timestamp, {
    ok: false,
    errorKind: 'unknown',
    error: err instanceof Error ? err.message : String(err),
    applied: 0,
    skipped: plan.items.length,
    bytesWritten: 0,
    backupCount: 0,
    conflicts: []
  });
}

function classifyError(err: unknown): SyncResultErrorKind {
  if (err instanceof SyncCancelledError) return 'cancelled';
  if (err instanceof SyncIntegrityError) return 'integrity';
  if (err instanceof SyncRefusedError) return err.kind;
  return 'unknown';
}

/* ───────────────── progress + status helpers ───────────────── */

function emit(ctx: ApplyPlanContext, p: SyncProgress): void {
  if (ctx.onProgress) {
    try {
      ctx.onProgress(p);
    } catch (err) {
      console.warn(`execute: onProgress threw: ${(err as Error).message}`);
    }
  }
}

function setPhase(
  ctx: ApplyPlanContext,
  phase: SyncPhase,
  index: number,
  total: number,
  message?: string
): void {
  currentStatus = {
    ...currentStatus,
    phase,
    completed: index,
    total,
    ...(message ? { lastError: message } : {})
  };
  emit(ctx, message ? { phase, index, total, message } : { phase, index, total });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SyncCancelledError();
}

/* ───────────────── small fs helpers ───────────────── */

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/* ───────────────── recovery helper (startup) ───────────────── */

/**
 * Sweep `<root>` for the sidecar artifacts atomic.ts leaves on crashes
 * (`*.df-syncer-windows.tmp` and `*.df-syncer-windows.del`). Returns a manifest of the
 * paths found; the caller decides whether to delete them or surface
 * to the user.
 *
 * Note: this does NOT auto-delete. Per the phase spec, recovery is a
 * surface-and-confirm operation, not an implicit cleanup.
 */
export async function recoverPendingFiles(root: string): Promise<{
  tmp: string[];
  del: string[];
}> {
  const out = { tmp: [] as string[], del: [] as string[] };
  await walkForSidecars(root, out);
  return out;
}

async function walkForSidecars(dir: string, out: { tmp: string[]; del: string[] }): Promise<void> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await walkForSidecars(abs, out);
    } else if (dirent.isFile()) {
      if (dirent.name.endsWith('.df-syncer-windows.tmp')) out.tmp.push(abs);
      else if (dirent.name.endsWith('.df-syncer-windows.del')) out.del.push(abs);
    }
  }
}
