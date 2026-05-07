import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore, DEFAULT_EXCLUDE_GLOBS, buildDefaultConfig } from '../../src/main/store';

/**
 * Phase 2 tests for the electron-store wrapper. We point each instance
 * at a unique temp directory via the `cwd` option so the on-disk file
 * lives outside the user's real userData and is cleaned up afterward.
 */

describe('buildDefaultConfig', () => {
  it('matches the documented defaults from §5.1', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.cloudFolder).toBe('');
    expect(cfg.gameFolder).toBe('');
    expect(cfg.enabledFolders).toEqual({
      data: false,
      mods: true,
      prefs: true,
      save: true
    });
    expect(cfg.conflictPolicy).toBe('newer-wins-backup');
    expect(cfg.backup.keepLastN).toBe(10);
    expect(cfg.backup.compress).toBe(true);
    expect(cfg.monitor.enabled).toBe(true);
    expect(cfg.monitor.onGameStart).toBe('prompt-pull');
    expect(cfg.monitor.onGameExit).toBe('prompt-push');
    expect(cfg.monitor.pollIntervalMs).toBe(3000);
    expect(cfg.firstRunCompleted).toBe(false);
    expect(cfg.startWithWindows).toBe(false);
    expect(cfg.startMinimizedToTray).toBe(false);
    expect(cfg.machineId.length).toBeGreaterThan(0);
    // §6.4 default excludes are present.
    for (const glob of DEFAULT_EXCLUDE_GLOBS) {
      expect(cfg.excludeGlobs).toContain(glob);
    }
  });
});

describe('ConfigStore', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'df-syncer-windows-store-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('seeds defaults on a fresh store', () => {
    const store = new ConfigStore({ cwd: tmp });
    const cfg = store.get();
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.firstRunCompleted).toBe(false);
    expect(cfg.enabledFolders.save).toBe(true);
  });

  it('isFirstRun returns true initially and false after firstRunCompleted is set', () => {
    const store = new ConfigStore({ cwd: tmp });
    expect(store.isFirstRun()).toBe(true);
    store.save({ firstRunCompleted: true });
    expect(store.isFirstRun()).toBe(false);
  });

  it('save() round-trips a partial patch', () => {
    const store = new ConfigStore({ cwd: tmp });
    const next = store.save({ machineId: 'test-pc', cloudFolder: 'C:\\Cloud' });
    expect(next.machineId).toBe('test-pc');
    expect(next.cloudFolder).toBe('C:\\Cloud');
    // Untouched defaults remain.
    expect(next.conflictPolicy).toBe('newer-wins-backup');
    expect(next.enabledFolders.save).toBe(true);
  });

  it('save() merges nested objects without stomping siblings', () => {
    const store = new ConfigStore({ cwd: tmp });
    store.save({ enabledFolders: { data: true } as never });
    const cfg = store.get();
    expect(cfg.enabledFolders.data).toBe(true);
    expect(cfg.enabledFolders.mods).toBe(true);
    expect(cfg.enabledFolders.prefs).toBe(true);
    expect(cfg.enabledFolders.save).toBe(true);

    store.save({ backup: { keepLastN: 25 } as never });
    expect(store.get().backup.keepLastN).toBe(25);
    expect(store.get().backup.compress).toBe(true);

    store.save({ monitor: { pollIntervalMs: 1500 } as never });
    expect(store.get().monitor.pollIntervalMs).toBe(1500);
    expect(store.get().monitor.onGameExit).toBe('prompt-push');
  });

  it('persists across instances at the same cwd', () => {
    const a = new ConfigStore({ cwd: tmp });
    a.save({ machineId: 'persisted-pc', firstRunCompleted: true });
    const b = new ConfigStore({ cwd: tmp });
    expect(b.get().machineId).toBe('persisted-pc');
    expect(b.isFirstRun()).toBe(false);
  });

  it('writes a config.json file inside the cwd', () => {
    const store = new ConfigStore({ cwd: tmp });
    store.save({ machineId: 'has-disk' });
    expect(store.path).toMatch(/config\.json$/i);
    expect(store.path.toLowerCase()).toContain(tmp.toLowerCase());
  });
});
