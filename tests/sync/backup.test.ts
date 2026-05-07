import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tar from 'tar';
import {
  beginBackup,
  buildTimestamp,
  pruneBackups,
  BackupFinalizedError
} from '../../src/main/sync/backup';

describe('backup primitives', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'df-syncer-windows-backup-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('buildTimestamp', () => {
    it('produces a Windows-safe ISO-derived timestamp', () => {
      const ts = buildTimestamp(new Date('2026-05-07T12:34:56.789Z'));
      expect(ts).toBe('2026-05-07T12-34-56-789Z');
      expect(ts.includes(':')).toBe(false);
      expect(ts.includes('.')).toBe(false);
    });

    it('preserves chronological order via lexicographic compare', () => {
      const a = buildTimestamp(new Date('2026-05-07T00:00:00.000Z'));
      const b = buildTimestamp(new Date('2026-05-08T00:00:00.000Z'));
      expect(a < b).toBe(true);
    });
  });

  describe('beginBackup + snapshot + finalize (uncompressed)', () => {
    it('snapshots a file into a loose dir tree', async () => {
      const src = path.join(root, 'live', 'save', 'world.dat');
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, 'world bytes');

      const session = await beginBackup(path.join(root, 'backups'));
      await session.snapshot(src, 'save/world.dat');
      const result = await session.finalize({ compress: false });

      expect(result.dirPath).toBe(session.dir);
      expect(result.archivePath).toBeUndefined();

      const restored = await fs.readFile(path.join(session.dir, 'save', 'world.dat'), 'utf8');
      expect(restored).toBe('world bytes');
      expect([...session.entries]).toEqual(['save/world.dat']);
    });

    it('snapshots multiple files and creates intermediate dirs', async () => {
      const a = path.join(root, 'live', 'a', 'a.txt');
      const b = path.join(root, 'live', 'b', 'sub', 'b.txt');
      await fs.mkdir(path.dirname(a), { recursive: true });
      await fs.mkdir(path.dirname(b), { recursive: true });
      await fs.writeFile(a, 'A');
      await fs.writeFile(b, 'B');

      const session = await beginBackup(path.join(root, 'backups'));
      await session.snapshot(a, 'a/a.txt');
      await session.snapshot(b, 'b/sub/b.txt');
      const result = await session.finalize({ compress: false });

      expect(result.dirPath).toBe(session.dir);
      const restoredA = await fs.readFile(path.join(session.dir, 'a', 'a.txt'), 'utf8');
      const restoredB = await fs.readFile(path.join(session.dir, 'b', 'sub', 'b.txt'), 'utf8');
      expect(restoredA).toBe('A');
      expect(restoredB).toBe('B');
    });
  });

  describe('beginBackup + snapshot + finalize (compressed)', () => {
    it('produces an extractable .tar.gz and removes the loose dir', async () => {
      const src = path.join(root, 'live', 'save', 'world.dat');
      await fs.mkdir(path.dirname(src), { recursive: true });
      const payload = 'compressed world bytes';
      await fs.writeFile(src, payload);

      const session = await beginBackup(path.join(root, 'backups'));
      await session.snapshot(src, 'save/world.dat');
      const result = await session.finalize({ compress: true });

      expect(result.archivePath).toBeDefined();
      expect(result.dirPath).toBeUndefined();
      // Archive exists.
      await expect(fs.access(result.archivePath as string)).resolves.toBeUndefined();
      // Loose dir gone.
      await expect(fs.access(session.dir)).rejects.toMatchObject({ code: 'ENOENT' });

      // Extract and verify bytes.
      const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-syncer-windows-extract-'));
      try {
        await tar.extract({ file: result.archivePath as string, cwd: extractDir });
        const extracted = await fs.readFile(
          path.join(extractDir, path.basename(session.dir), 'save', 'world.dat'),
          'utf8'
        );
        expect(extracted).toBe(payload);
      } finally {
        await fs.rm(extractDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });

  describe('finalize with no entries', () => {
    it('removes the empty dir and returns nothing', async () => {
      const session = await beginBackup(path.join(root, 'backups'));
      const result = await session.finalize({ compress: true });
      expect(result.dirPath).toBeUndefined();
      expect(result.archivePath).toBeUndefined();
      await expect(fs.access(session.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('also removes the empty dir when compress is false', async () => {
      const session = await beginBackup(path.join(root, 'backups'));
      const result = await session.finalize({ compress: false });
      expect(result.dirPath).toBeUndefined();
      expect(result.archivePath).toBeUndefined();
      await expect(fs.access(session.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('finalize is single-shot', () => {
    it('throws BackupFinalizedError on second call', async () => {
      const session = await beginBackup(path.join(root, 'backups'));
      await session.finalize({ compress: false });
      await expect(session.finalize({ compress: false })).rejects.toBeInstanceOf(
        BackupFinalizedError
      );
    });

    it('refuses snapshot after finalize', async () => {
      const src = path.join(root, 'live', 'a.txt');
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, 'a');
      const session = await beginBackup(path.join(root, 'backups'));
      await session.finalize({ compress: false });
      await expect(session.snapshot(src, 'a.txt')).rejects.toBeInstanceOf(BackupFinalizedError);
    });
  });

  describe('snapshot input validation', () => {
    it('rejects empty rel', async () => {
      const session = await beginBackup(path.join(root, 'backups'));
      await expect(session.snapshot('whatever', '')).rejects.toThrow(/Invalid backup-relative/);
      await session.finalize({ compress: false });
    });

    it('rejects parent-traversal in rel', async () => {
      const session = await beginBackup(path.join(root, 'backups'));
      await expect(session.snapshot('whatever', '../escape.txt')).rejects.toThrow(
        /Invalid backup-relative/
      );
      await session.finalize({ compress: false });
    });
  });

  describe('snapshot with directory trees', () => {
    it('copies a directory recursively when rel ends with /', async () => {
      const treeRoot = path.join(root, 'live', 'mods', 'cool-mod');
      await fs.mkdir(path.join(treeRoot, 'data'), { recursive: true });
      await fs.writeFile(path.join(treeRoot, 'manifest.txt'), 'm');
      await fs.writeFile(path.join(treeRoot, 'data', 'a.txt'), 'a');
      await fs.writeFile(path.join(treeRoot, 'data', 'b.txt'), 'b');

      const session = await beginBackup(path.join(root, 'backups'));
      await session.snapshot(treeRoot, 'mods/cool-mod/');
      await session.finalize({ compress: false });

      const dest = path.join(session.dir, 'mods', 'cool-mod');
      await expect(fs.readFile(path.join(dest, 'manifest.txt'), 'utf8')).resolves.toBe('m');
      await expect(fs.readFile(path.join(dest, 'data', 'a.txt'), 'utf8')).resolves.toBe('a');
      await expect(fs.readFile(path.join(dest, 'data', 'b.txt'), 'utf8')).resolves.toBe('b');
    });
  });

  describe('pruneBackups', () => {
    /** Create a stub backup name (loose dir) under `root`. */
    async function stubLooseDir(name: string, fileContent = 'x'): Promise<void> {
      const dir = path.join(root, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'placeholder.txt'), fileContent);
    }

    /** Create a stub `.tar.gz` archive under `root`. */
    async function stubArchive(name: string, content = 'archive'): Promise<void> {
      await fs.writeFile(path.join(root, name), content);
    }

    it('keeps the 3 newest of 5 mixed backups', async () => {
      // 5 ascending timestamps; only the 3 newest should survive.
      const stamps = [
        '2026-05-01T00-00-00-000Z',
        '2026-05-02T00-00-00-000Z',
        '2026-05-03T00-00-00-000Z',
        '2026-05-04T00-00-00-000Z',
        '2026-05-05T00-00-00-000Z'
      ];
      // Mix loose dirs and tar.gz to exercise both branches.
      await stubLooseDir(stamps[0]);
      await stubArchive(stamps[1] + '.tar.gz');
      await stubLooseDir(stamps[2]);
      await stubArchive(stamps[3] + '.tar.gz');
      await stubLooseDir(stamps[4]);

      const { removed } = await pruneBackups(root, 3);

      expect(removed).toHaveLength(2);
      expect(removed.map((p) => path.basename(p)).sort()).toEqual(
        [stamps[0], stamps[1] + '.tar.gz'].sort()
      );

      const remaining = (await fs.readdir(root)).sort();
      expect(remaining).toEqual([stamps[2], stamps[3] + '.tar.gz', stamps[4]].sort());
    });

    it('keeps everything when keepLastN >= count', async () => {
      await stubLooseDir('2026-05-01T00-00-00-000Z');
      await stubLooseDir('2026-05-02T00-00-00-000Z');
      const { removed } = await pruneBackups(root, 5);
      expect(removed).toEqual([]);
    });

    it('removes everything when keepLastN is 0', async () => {
      await stubLooseDir('2026-05-01T00-00-00-000Z');
      await stubArchive('2026-05-02T00-00-00-000Z.tar.gz');
      const { removed } = await pruneBackups(root, 0);
      expect(removed).toHaveLength(2);
      expect(await fs.readdir(root)).toEqual([]);
    });

    it('ignores files that do not match the timestamp shape', async () => {
      await stubLooseDir('2026-05-01T00-00-00-000Z');
      await stubLooseDir('2026-05-02T00-00-00-000Z');
      await stubLooseDir('2026-05-03T00-00-00-000Z');
      // Unrelated user-created junk.
      await fs.writeFile(path.join(root, 'README.md'), 'leave me');
      await fs.mkdir(path.join(root, 'random-folder'));

      const { removed } = await pruneBackups(root, 1);
      expect(removed).toHaveLength(2);
      // Junk is still there.
      await expect(fs.access(path.join(root, 'README.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, 'random-folder'))).resolves.toBeUndefined();
    });

    it('returns an empty list when the root does not exist', async () => {
      const ghost = path.join(root, 'never-was');
      const { removed } = await pruneBackups(ghost, 3);
      expect(removed).toEqual([]);
    });

    it('rejects negative keepLastN', async () => {
      await expect(pruneBackups(root, -1)).rejects.toThrow(/non-negative/);
    });
  });

  describe('beginBackup timestamp safety', () => {
    it('refuses path-separator characters in timestamp', async () => {
      await expect(beginBackup(root, 'a/b')).rejects.toThrow(/Invalid backup timestamp/);
      await expect(beginBackup(root, '..')).rejects.toThrow(/Invalid backup timestamp/);
    });
  });
});
