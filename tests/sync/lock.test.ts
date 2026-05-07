import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireCloudLock,
  getLockPath,
  LockHeldError,
  releaseCloudLock,
  withCloudLock,
  type LockOwner
} from '../../src/main/sync/lock';

describe('cloud lock', () => {
  let cloud: string;

  beforeEach(async () => {
    cloud = await fs.mkdtemp(path.join(os.tmpdir(), 'df-syncer-windows-lock-'));
  });

  afterEach(async () => {
    await fs.rm(cloud, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /**
   * Manually drop a lock at the conventional path with a chosen
   * acquiredAt. Used to simulate "another machine holds it" and
   * "stale self-held" scenarios.
   */
  async function plantLock(
    cloudFolder: string,
    owner: Partial<LockOwner> & { machineId: string }
  ): Promise<LockOwner> {
    const full: LockOwner = {
      machineId: owner.machineId,
      pid: owner.pid ?? 1234,
      acquiredAt: owner.acquiredAt ?? new Date().toISOString(),
      hostname: owner.hostname ?? 'planted-host'
    };
    const lockPath = getLockPath(cloudFolder);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(full, null, 2) + '\n', 'utf8');
    return full;
  }

  describe('acquireCloudLock', () => {
    it('writes lock.json on a clean cloud folder and returns the new owner', async () => {
      const owner = await acquireCloudLock(cloud, 'pc-A');

      expect(owner.machineId).toBe('pc-A');
      expect(owner.pid).toBe(process.pid);
      expect(typeof owner.hostname).toBe('string');
      expect(typeof owner.acquiredAt).toBe('string');

      const onDisk = JSON.parse(await fs.readFile(getLockPath(cloud), 'utf8')) as LockOwner;
      expect(onDisk.machineId).toBe(owner.machineId);
      expect(onDisk.pid).toBe(owner.pid);
      expect(onDisk.acquiredAt).toBe(owner.acquiredAt);
      expect(onDisk.hostname).toBe(owner.hostname);
    });

    it('throws LockHeldError when another machine holds it', async () => {
      const planted = await plantLock(cloud, { machineId: 'pc-B' });
      await expect(acquireCloudLock(cloud, 'pc-A')).rejects.toMatchObject({
        name: 'LockHeldError',
        owner: { machineId: 'pc-B', pid: planted.pid, acquiredAt: planted.acquiredAt }
      });
    });

    it('throws LockHeldError when same machine holds a fresh lock', async () => {
      await plantLock(cloud, {
        machineId: 'pc-A',
        acquiredAt: new Date(Date.now() - 60_000).toISOString() // 1 min old
      });
      await expect(acquireCloudLock(cloud, 'pc-A', { staleMinutes: 10 })).rejects.toBeInstanceOf(
        LockHeldError
      );
    });

    it('throws when same-machine lock is stale but no callback is provided', async () => {
      await plantLock(cloud, {
        machineId: 'pc-A',
        acquiredAt: new Date(Date.now() - 30 * 60_000).toISOString() // 30 min old
      });
      await expect(acquireCloudLock(cloud, 'pc-A', { staleMinutes: 10 })).rejects.toBeInstanceOf(
        LockHeldError
      );
    });

    it('clears a stale self-lock when callback returns true', async () => {
      const planted = await plantLock(cloud, {
        machineId: 'pc-A',
        pid: 99,
        acquiredAt: new Date(Date.now() - 30 * 60_000).toISOString()
      });
      const cb = vi.fn().mockResolvedValue(true);

      const owner = await acquireCloudLock(cloud, 'pc-A', {
        staleMinutes: 10,
        onStaleSelfLock: cb
      });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          machineId: 'pc-A',
          pid: planted.pid,
          acquiredAt: planted.acquiredAt
        })
      );
      // New owner replaces the planted one.
      expect(owner.pid).toBe(process.pid);
      const onDisk = JSON.parse(await fs.readFile(getLockPath(cloud), 'utf8')) as LockOwner;
      expect(onDisk.pid).toBe(process.pid);
      expect(onDisk.acquiredAt).not.toBe(planted.acquiredAt);
    });

    it('refuses to clear a stale self-lock when callback returns false', async () => {
      await plantLock(cloud, {
        machineId: 'pc-A',
        acquiredAt: new Date(Date.now() - 30 * 60_000).toISOString()
      });
      const cb = vi.fn().mockResolvedValue(false);
      await expect(
        acquireCloudLock(cloud, 'pc-A', {
          staleMinutes: 10,
          onStaleSelfLock: cb
        })
      ).rejects.toBeInstanceOf(LockHeldError);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('does not auto-clear another machine even when its lock is stale', async () => {
      await plantLock(cloud, {
        machineId: 'pc-B',
        acquiredAt: new Date(Date.now() - 60 * 60_000).toISOString()
      });
      const cb = vi.fn().mockResolvedValue(true);
      await expect(
        acquireCloudLock(cloud, 'pc-A', { staleMinutes: 10, onStaleSelfLock: cb })
      ).rejects.toBeInstanceOf(LockHeldError);
      // Callback must not even be consulted for foreign locks.
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('releaseCloudLock', () => {
    it('removes the lock when the owner matches', async () => {
      await acquireCloudLock(cloud, 'pc-A');
      await releaseCloudLock(cloud, 'pc-A');
      await expect(fs.access(getLockPath(cloud))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not remove the lock if a different machine owns it', async () => {
      await plantLock(cloud, { machineId: 'pc-B' });
      await releaseCloudLock(cloud, 'pc-A');
      // Still there.
      const onDisk = JSON.parse(await fs.readFile(getLockPath(cloud), 'utf8')) as LockOwner;
      expect(onDisk.machineId).toBe('pc-B');
    });

    it('is a no-op when no lock exists', async () => {
      await expect(releaseCloudLock(cloud, 'pc-A')).resolves.toBeUndefined();
    });
  });

  describe('withCloudLock', () => {
    it('runs fn while holding the lock and releases on success', async () => {
      let observedLockExists = false;
      const result = await withCloudLock(cloud, 'pc-A', {}, async () => {
        observedLockExists = await fileExists(getLockPath(cloud));
        return 42;
      });
      expect(result).toBe(42);
      expect(observedLockExists).toBe(true);
      await expect(fs.access(getLockPath(cloud))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('releases the lock even when fn throws', async () => {
      await expect(
        withCloudLock(cloud, 'pc-A', {}, async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow(/boom/);
      await expect(fs.access(getLockPath(cloud))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not call fn if acquire throws (lock held)', async () => {
      await plantLock(cloud, { machineId: 'pc-B' });
      const fn = vi.fn().mockResolvedValue('never');
      await expect(withCloudLock(cloud, 'pc-A', {}, fn)).rejects.toBeInstanceOf(LockHeldError);
      expect(fn).not.toHaveBeenCalled();
      // Foreign lock is left untouched.
      const onDisk = JSON.parse(await fs.readFile(getLockPath(cloud), 'utf8')) as LockOwner;
      expect(onDisk.machineId).toBe('pc-B');
    });
  });

  describe('two simulated machines cannot both acquire', () => {
    it('one wins, the other throws LockHeldError', async () => {
      const ownerA = await acquireCloudLock(cloud, 'pc-A');
      expect(ownerA.machineId).toBe('pc-A');

      await expect(acquireCloudLock(cloud, 'pc-B')).rejects.toBeInstanceOf(LockHeldError);

      // After A releases, B should be able to acquire.
      await releaseCloudLock(cloud, 'pc-A');
      const ownerB = await acquireCloudLock(cloud, 'pc-B');
      expect(ownerB.machineId).toBe('pc-B');
    });
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
