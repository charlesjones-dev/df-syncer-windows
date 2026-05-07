/**
 * Phase 6 — applyPlan integration tests.
 *
 * Each scenario uses real temp directories for both the "local game
 * folder" and the "cloud folder", and drives the engine end-to-end
 * (no mocked filesystem). The tests cover every acceptance criterion
 * in the phase spec: clean push/pull, conflicts, deletes, dry-run,
 * abort, single-flight, df-running, free-space, history persistence,
 * and backup retention.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPlan,
  cancelInProgressSync,
  getSyncStatus,
  recoverPendingFiles,
  SyncInProgressError,
  type ApplyPlanContext
} from '../../src/main/sync/execute';
import type {
  AppConfig,
  FileEntry,
  Manifest,
  SyncPlan,
  SyncPlanItem
} from '../../src/shared/types';
import { scanFolder } from '../../src/main/sync/scan';
import {
  buildManifestFromEntries,
  readCloudManifest,
  readLastBaseManifest,
  writeCloudManifest,
  writeLastBaseManifest
} from '../../src/main/sync/manifest';
import { diff } from '../../src/main/sync/diff';
import { materializePlan } from '../../src/main/sync/diff-applier';
import { listHistory } from '../../src/main/history';

/* ───────────────── fixtures ───────────────── */

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function defaultConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    schemaVersion: 1,
    cloudFolder: '',
    gameFolder: '',
    enabledFolders: { data: false, mods: true, prefs: true, save: true },
    excludeGlobs: ['df-syncer-windows/**'],
    machineId: 'pc-test',
    conflictPolicy: 'newer-wins-backup',
    backup: { keepLastN: 10, compress: false },
    monitor: {
      enabled: false,
      onGameStart: 'do-nothing',
      onGameExit: 'do-nothing',
      pollIntervalMs: 3000
    },
    startWithWindows: false,
    startMinimizedToTray: false,
    firstRunCompleted: true,
    ...overrides
  };
}

/**
 * Build a `SyncPlan` for a test scenario by scanning the temp local
 * game folder + cloud mirror, optionally seeding `last-cloud.json` as
 * the base, then running diff + materialize. Mirrors the production
 * `buildPlanForConfig` flow.
 */
async function buildPlan(
  ctx: ApplyPlanContext,
  base?: Manifest | null
): Promise<SyncPlan> {
  const localEntries: FileEntry[] = [];
  for (const sub of ['data', 'mods', 'prefs', 'save'] as const) {
    if (!ctx.config.enabledFolders[sub]) continue;
    const root = path.join(ctx.gameFolder, sub);
    try {
      const entries = await scanFolder(root, { excludeGlobs: ctx.config.excludeGlobs });
      for (const e of entries) localEntries.push({ ...e, rel: `${sub}/${e.rel}` });
    } catch {
      // missing folder → skip
    }
  }
  localEntries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const local = buildManifestFromEntries(localEntries, ctx.machineId);

  const cloudMirror = path.join(ctx.cloudFolder, 'df-syncer-windows', 'mirror');
  let cloudEntries: FileEntry[] = [];
  try {
    cloudEntries = await scanFolder(cloudMirror, { excludeGlobs: ctx.config.excludeGlobs });
  } catch {
    cloudEntries = [];
  }
  const cloud = buildManifestFromEntries(cloudEntries, ctx.machineId);

  const baseManifest =
    base !== undefined
      ? base
      : await readLastBaseManifest(ctx.userDataDir).catch(() => null);

  const rawPlan = diff(local, cloud, baseManifest, {
    direction: 'full',
    conflictPolicy: ctx.config.conflictPolicy
  });
  const materialized = materializePlan(rawPlan, ctx.config.conflictPolicy);
  return materialized.plan;
}

async function writeFile(absPath: string, content: string, mtimeMs?: number): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
  if (mtimeMs !== undefined) {
    const mtime = new Date(mtimeMs);
    await fs.utimes(absPath, mtime, mtime);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function makeCtx(overrides: Partial<ApplyPlanContext>): ApplyPlanContext {
  // The required fields must always be present in overrides; this
  // helper just adds a sensible signal default.
  return {
    onProgress: undefined,
    signal: new AbortController().signal,
    ...overrides
  } as ApplyPlanContext;
}

/* ───────────────── tests ───────────────── */

describe('applyPlan', () => {
  let local: string;
  let cloud: string;
  let userData: string;
  let backupRoot: string;

  beforeEach(async () => {
    local = await makeTempDir('df-syncer-windows-exec-local-');
    cloud = await makeTempDir('df-syncer-windows-exec-cloud-');
    userData = await makeTempDir('df-syncer-windows-exec-userdata-');
    backupRoot = await makeTempDir('df-syncer-windows-exec-backup-');
  });

  afterEach(async () => {
    const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
    await fs.rm(local, rmOpts);
    await fs.rm(cloud, rmOpts);
    await fs.rm(userData, rmOpts);
    await fs.rm(backupRoot, rmOpts);
  });

  /* ── 1. Clean push ── */
  it('clean push: seeds an empty cloud from a populated local', async () => {
    await writeFile(path.join(local, 'save', 'world.sav'), 'world bytes');
    await writeFile(path.join(local, 'mods', 'cool', 'init.lua'), 'lua content');
    await writeFile(path.join(local, 'prefs', 'announcements.txt'), 'pref a');

    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan = await buildPlan(ctx, null);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(3);
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.backupCount).toBe(0);

    // Cloud mirrors local.
    expect(await pathExists(path.join(cloud, 'df-syncer-windows', 'mirror', 'save', 'world.sav'))).toBe(true);
    expect(await pathExists(path.join(cloud, 'df-syncer-windows', 'mirror', 'mods', 'cool', 'init.lua'))).toBe(
      true
    );
    expect(await pathExists(path.join(cloud, 'df-syncer-windows', 'mirror', 'prefs', 'announcements.txt'))).toBe(
      true
    );

    // Manifests written.
    const cloudManifest = await readCloudManifest(cloud);
    expect(cloudManifest).not.toBeNull();
    expect(cloudManifest!.files.length).toBe(3);

    const baseManifest = await readLastBaseManifest(userData);
    expect(baseManifest).not.toBeNull();
    expect(baseManifest!.files.length).toBe(3);

    // History entry persisted.
    const history = await listHistory(userData);
    expect(history.length).toBe(1);
    expect(history[0].direction).toBe('full');
    expect(history[0].result.ok).toBe(true);
  });

  /* ── 2. Clean pull ── */
  it('clean pull: populates an empty local from a populated cloud mirror', async () => {
    await writeFile(path.join(cloud, 'df-syncer-windows', 'mirror', 'save', 'world.sav'), 'world content');
    await writeFile(path.join(cloud, 'df-syncer-windows', 'mirror', 'mods', 'm.lua'), 'm content');

    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan = await buildPlan(ctx, null);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(2);
    expect(result.backupCount).toBe(0);

    // Local now has the files.
    expect(await pathExists(path.join(local, 'save', 'world.sav'))).toBe(true);
    expect(await pathExists(path.join(local, 'mods', 'm.lua'))).toBe(true);
  });

  /* ── 3. Conflict modify-both → newer-wins-backup ── */
  it('conflict modify-both: newer-wins-backup applies winner and snapshots loser', async () => {
    // Step 1: build the v1 base. Both sides start with identical content.
    const rel = 'save/world.sav';
    await writeFile(path.join(local, rel), 'v1', 1_000_000_000_000);
    await writeFile(path.join(cloud, 'df-syncer-windows', 'mirror', rel), 'v1', 1_000_000_000_000);

    // Seed the base manifest as the post-v1 state.
    const baseEntries = await scanFolder(path.join(local, 'save'), { excludeGlobs: [] });
    const base = buildManifestFromEntries(
      baseEntries.map((e) => ({ ...e, rel: `save/${e.rel}` })),
      'pc-test'
    );
    await writeLastBaseManifest(userData, base);
    await writeCloudManifest(cloud, base);

    // Step 2: diverge. Local edits to v2-local at mtime 1_000_000_010_000;
    // cloud edits to v2-cloud at mtime 1_000_000_020_000 (cloud newer by 10s).
    await writeFile(path.join(local, rel), 'v2-local', 1_000_000_010_000);
    await writeFile(
      path.join(cloud, 'df-syncer-windows', 'mirror', rel),
      'v2-cloud',
      1_000_000_020_000
    );

    const config = defaultConfig({
      cloudFolder: cloud,
      gameFolder: local,
      backup: { keepLastN: 10, compress: false }
    });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan = await buildPlan(ctx);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);

    // Cloud was newer → pull. Local should now have v2-cloud content.
    const localContent = await fs.readFile(path.join(local, rel), 'utf8');
    expect(localContent).toBe('v2-cloud');

    // Loser (v2-local) was backed up before overwrite.
    expect(result.backupCount).toBe(1);
    const backupFile = path.join(backupRoot, result.backupTimestamp!, rel);
    expect(await pathExists(backupFile)).toBe(true);
    const backupContent = await fs.readFile(backupFile, 'utf8');
    expect(backupContent).toBe('v2-local');

    // Last-base manifest reflects the new state.
    const newBase = await readLastBaseManifest(userData);
    const baseEntry = newBase!.files.find((f) => f.rel === rel);
    expect(baseEntry).toBeDefined();
    // Hashing 'v2-cloud' content should yield a known sha1; we just
    // confirm it differs from the original 'v1'.
    expect(baseEntry!.sha1).not.toBe(base.files[0].sha1);
  });

  /* ── 4. Push-delete ── */
  it('push-delete: removes a file from cloud, backs it up first', async () => {
    // Base: same file on both sides.
    const rel = 'save/old.sav';
    await writeFile(path.join(local, rel), 'old');
    await writeFile(path.join(cloud, 'df-syncer-windows', 'mirror', rel), 'old');
    const baseEntries = await scanFolder(path.join(local, 'save'), { excludeGlobs: [] });
    const base = buildManifestFromEntries(
      baseEntries.map((e) => ({ ...e, rel: `save/${e.rel}` })),
      'pc-test'
    );
    await writeLastBaseManifest(userData, base);
    await writeCloudManifest(cloud, base);

    // Delete locally.
    await fs.rm(path.join(local, rel));

    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan = await buildPlan(ctx);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);
    expect(await pathExists(path.join(cloud, 'df-syncer-windows', 'mirror', rel))).toBe(false);
    // The displaced cloud file is in the backup.
    expect(result.backupCount).toBe(1);
    expect(await pathExists(path.join(backupRoot, result.backupTimestamp!, rel))).toBe(true);
  });

  /* ── 5. Pull-delete ── */
  it('pull-delete: removes a file from local, backs it up first', async () => {
    const rel = 'save/old.sav';
    await writeFile(path.join(local, rel), 'old');
    await writeFile(path.join(cloud, 'df-syncer-windows', 'mirror', rel), 'old');
    const baseEntries = await scanFolder(path.join(local, 'save'), { excludeGlobs: [] });
    const base = buildManifestFromEntries(
      baseEntries.map((e) => ({ ...e, rel: `save/${e.rel}` })),
      'pc-test'
    );
    await writeLastBaseManifest(userData, base);
    await writeCloudManifest(cloud, base);

    // Delete cloud-side.
    await fs.rm(path.join(cloud, 'df-syncer-windows', 'mirror', rel));

    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan = await buildPlan(ctx);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);
    expect(await pathExists(path.join(local, rel))).toBe(false);
    expect(result.backupCount).toBe(1);
  });

  /* ── 6. Dry-run ── */
  it('dry-run: produces a result with applied count but writes nothing', async () => {
    await writeFile(path.join(local, 'save', 'a.sav'), 'a');
    await writeFile(path.join(local, 'save', 'b.sav'), 'b');

    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: true,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan = await buildPlan(ctx, null);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(2);
    expect(result.bytesWritten).toBe(0);

    // Nothing on the cloud side.
    expect(await pathExists(path.join(cloud, 'df-syncer-windows', 'mirror', 'save', 'a.sav'))).toBe(false);
    expect(await readCloudManifest(cloud)).toBeNull();
    expect(await readLastBaseManifest(userData)).toBeNull();

    // No history entry persisted for dry-run (we don't write history
    // for dry runs, but the test just confirms the side-effect
    // surface is empty).
  });

  /* ── 7. AbortSignal mid-apply ── */
  it('abort mid-apply: lock released, backup finalised, no manifest written', async () => {
    // Many small files so we can abort during the loop.
    for (let i = 0; i < 20; i += 1) {
      await writeFile(path.join(local, 'save', `f${i}.sav`), `content-${i}`);
    }

    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const abort = new AbortController();
    let progressCount = 0;
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot,
      signal: abort.signal,
      onProgress: (p) => {
        if (p.phase === 'apply' && p.index === 5) {
          // Abort after 5 items have been emitted.
          abort.abort();
        }
        progressCount += 1;
      }
    });
    const plan = await buildPlan(ctx, null);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('cancelled');
    // No cloud manifest (apply was aborted).
    expect(await readCloudManifest(cloud)).toBeNull();
    // No last-base manifest.
    expect(await readLastBaseManifest(userData)).toBeNull();
    // Lock file is gone (released in finally).
    expect(await pathExists(path.join(cloud, 'df-syncer-windows', 'lock.json'))).toBe(false);
    expect(progressCount).toBeGreaterThan(0);
  });

  /* ── 8. Concurrent apply ── */
  it('concurrent apply: second call rejects with SyncInProgressError', async () => {
    // Set up a slow scenario by making lots of files.
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(local, 'save', `f${i}.sav`), `c${i}`);
    }
    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx1 = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan = await buildPlan(ctx1, null);

    const p1 = applyPlan(plan, ctx1);
    // Second call must reject immediately with SyncInProgressError.
    await expect(applyPlan(plan, ctx1)).rejects.toBeInstanceOf(SyncInProgressError);
    const r1 = await p1;
    expect(r1.ok).toBe(true);
  });

  /* ── 9. DF-running pre-check ── */
  it('df-running pre-check: refuses immediately', async () => {
    await writeFile(path.join(local, 'save', 'x.sav'), 'x');
    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot,
      dfRunning: true
    });
    const plan = await buildPlan(ctx, null);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('df-running');
    expect(await pathExists(path.join(cloud, 'df-syncer-windows', 'mirror'))).toBe(false);
  });

  /* ── 10. Free-space pre-check ── */
  it('free-space pre-check: refuses when free < 1.2 × planned bytes', async () => {
    await writeFile(path.join(local, 'save', 'big.sav'), 'X'.repeat(1000));
    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot,
      // Stub probe: report free = 100 bytes (< 1000 × 1.2 = 1200).
      freeBytesProbe: async () => 100
    });
    const plan = await buildPlan(ctx, null);
    const result = await applyPlan(plan, ctx);

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('insufficient-cloud-space');
    expect(await readCloudManifest(cloud)).toBeNull();
  });

  /* ── 11. History persistence ── */
  it('history persistence: 3 successive applies → 3 entries newest-first', async () => {
    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const baseCtx = {
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    };

    for (let round = 1; round <= 3; round += 1) {
      await writeFile(path.join(local, 'save', `round${round}.sav`), `r${round}`);
      const ctx = makeCtx({
        ...baseCtx,
        // Inject a fixed clock per round so timestamps are deterministic
        // and lex-sortable.
        clock: () => new Date(1_000_000_000_000 + round * 1000)
      });
      const plan = await buildPlan(ctx);
      const result = await applyPlan(plan, ctx);
      expect(result.ok).toBe(true);
    }

    const history = await listHistory(userData);
    expect(history.length).toBe(3);
    // Newest first: round 3 timestamp > round 2 > round 1.
    expect(history[0].timestamp > history[1].timestamp).toBe(true);
    expect(history[1].timestamp > history[2].timestamp).toBe(true);
  });

  /* ── 12. Backup retention ── */
  it('backup retention: keepLastN=2 + 4 displacing applies → only 2 newest survive', async () => {
    // Each round modifies the same file so the cloud-side file is
    // displaced into a backup. With keepLastN=2 we expect at most 2
    // backup artifacts at the end.
    const config = defaultConfig({
      cloudFolder: cloud,
      gameFolder: local,
      backup: { keepLastN: 2, compress: false }
    });

    const rel = 'save/world.sav';
    // Seed both sides with v0.
    await writeFile(path.join(local, rel), 'v0');
    await writeFile(path.join(cloud, 'df-syncer-windows', 'mirror', rel), 'v0');
    const baseEntries = await scanFolder(path.join(local, 'save'), { excludeGlobs: [] });
    const v0Base = buildManifestFromEntries(
      baseEntries.map((e) => ({ ...e, rel: `save/${e.rel}` })),
      'pc-test'
    );
    await writeLastBaseManifest(userData, v0Base);
    await writeCloudManifest(cloud, v0Base);

    for (let round = 1; round <= 4; round += 1) {
      // Modify local to vN.
      await writeFile(path.join(local, rel), `v${round}`);
      const ctx = makeCtx({
        config,
        dryRun: false,
        machineId: 'pc-test',
        cloudFolder: cloud,
        gameFolder: local,
        userDataDir: userData,
        backupRootDir: backupRoot,
        clock: () => new Date(1_000_000_000_000 + round * 1000)
      });
      const plan = await buildPlan(ctx);
      const result = await applyPlan(plan, ctx);
      expect(result.ok).toBe(true);
      expect(result.backupCount).toBe(1); // one displaced cloud file per round
    }

    const dirents = await fs.readdir(backupRoot);
    expect(dirents.length).toBe(2);
  });

  /* ── Empty plan early exit (sanity, idempotency) ── */
  it('empty plan: no-op exit; no manifest write', async () => {
    // Local + cloud already in sync (both empty enabled folders).
    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan = await buildPlan(ctx, null);
    expect(plan.items.length).toBe(0);
    const result = await applyPlan(plan, ctx);
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(0);
    // Cloud manifest NOT written for an empty plan.
    expect(await readCloudManifest(cloud)).toBeNull();
  });

  /* ── Idempotency (re-run after success is a no-op) ── */
  it('idempotency: re-running after a successful apply produces an empty plan', async () => {
    await writeFile(path.join(local, 'save', 'x.sav'), 'x');
    const config = defaultConfig({ cloudFolder: cloud, gameFolder: local });
    const ctx = makeCtx({
      config,
      dryRun: false,
      machineId: 'pc-test',
      cloudFolder: cloud,
      gameFolder: local,
      userDataDir: userData,
      backupRootDir: backupRoot
    });
    const plan1 = await buildPlan(ctx, null);
    const r1 = await applyPlan(plan1, ctx);
    expect(r1.ok).toBe(true);

    // Second pass — base now reflects the post-first-apply state.
    const plan2 = await buildPlan(ctx);
    expect(plan2.items.filter((i: SyncPlanItem) => i.applied).length).toBe(0);
    const r2 = await applyPlan(plan2, ctx);
    expect(r2.ok).toBe(true);
    expect(r2.applied).toBe(0);
  });

  /* ── recoverPendingFiles helper ── */
  it('recoverPendingFiles: locates orphaned .tmp and .del sidecars', async () => {
    const root = await makeTempDir('df-syncer-windows-exec-recover-');
    try {
      await writeFile(path.join(root, 'a.txt.df-syncer-windows.tmp'), 'tmp');
      await writeFile(path.join(root, 'sub', 'b.txt.df-syncer-windows.del'), 'del');
      await writeFile(path.join(root, 'normal.txt'), 'normal');
      const found = await recoverPendingFiles(root);
      expect(found.tmp.length).toBe(1);
      expect(found.del.length).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  /* ── Status snapshot ── */
  it('status: getSyncStatus reports inProgress=false at rest', () => {
    const status = getSyncStatus();
    expect(status.inProgress).toBe(false);
  });

  /* ── Cancel: no-op when nothing is running ── */
  it('cancel: returns false when no sync is running', () => {
    expect(cancelInProgressSync()).toBe(false);
  });
});
