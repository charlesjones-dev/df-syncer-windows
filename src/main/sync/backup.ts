/**
 * Backup primitives.
 *
 * Before any local destructive sync action (overwrite or delete), the
 * executor `snapshot`s the displaced bytes into a per-run timestamped
 * folder under the configured backup root (typically
 * `%LOCALAPPDATA%\df-syncer-windows\backups\<timestamp>\`). After the run, the
 * folder is optionally rolled into `<timestamp>.tar.gz` and the loose
 * tree is removed; older snapshots beyond `keepLastN` are pruned.
 *
 * This module deals only with the filesystem side; the executor (Phase
 * 6) is responsible for choosing what to snapshot and when to finalize.
 *
 * Tar invocation uses the `tar` package (pinned via `pnpm.overrides` to
 * `>=7.5.7`). `tar.create({ gzip: true, ... })` produces `.tar.gz`;
 * `tar.extract` (used in tests) round-trips it.
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

/**
 * One in-flight backup run. Returned by {@link beginBackup}; the
 * executor calls {@link snapshot} for each displaced file and finally
 * {@link finalize} to either compress the loose tree into a `.tar.gz`
 * or leave the folder in place.
 *
 * Instances are not reusable: once `finalize` runs the directory may
 * have been removed.
 */
export class BackupSession {
  /** Absolute path of the loose-tree directory for this run. */
  public readonly dir: string;

  /** ISO-shaped timestamp this session was created with. */
  public readonly timestamp: string;

  /** Set of relative paths actually snapshotted. Empty until {@link snapshot} runs. */
  public readonly entries: Set<string> = new Set<string>();

  private finalized = false;

  constructor(timestamp: string, dir: string) {
    this.timestamp = timestamp;
    this.dir = dir;
  }

  /**
   * Copy a single file (or, if `rel` ends with `/`, a directory tree)
   * into the backup directory under the same relative path. Parent
   * directories are created as needed.
   *
   * `rel` is interpreted POSIX-style — callers building `rel` from a
   * Windows absolute path should normalise separators first.
   */
  async snapshot(absPath: string, rel: string): Promise<void> {
    if (this.finalized) {
      throw new BackupFinalizedError();
    }
    if (!rel || rel.startsWith('/') || rel.startsWith('\\') || rel.includes('..')) {
      throw new Error(`Invalid backup-relative path: ${rel}`);
    }

    const isDir = rel.endsWith('/') || rel.endsWith('\\');
    const cleanRel = isDir ? rel.replace(/[\\/]+$/, '') : rel;
    const dest = path.join(this.dir, cleanRel);
    await fs.mkdir(path.dirname(dest), { recursive: true });

    if (isDir) {
      await copyDirectoryRecursive(absPath, dest);
    } else {
      // Single-file snapshot. Use streaming copy so very large saves
      // don't balloon memory.
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const fh = await fs.open(dest, 'wx');
      try {
        await pipeline(createReadStream(absPath), fh.createWriteStream());
      } finally {
        await fh.close();
      }
    }

    this.entries.add(cleanRel);
  }

  /**
   * Close out the session.
   *
   * - If no entries were snapshotted, the (now-empty) directory is
   *   removed and `{}` is returned. Callers that want to detect "no
   *   backup was needed" can `if (!result.archivePath && !result.dirPath)`.
   * - If `compress` is true, the directory is rolled into
   *   `<dir>.tar.gz`, the loose tree is removed, and `{ archivePath }`
   *   is returned.
   * - Otherwise the loose tree is preserved and `{ dirPath }` is
   *   returned.
   *
   * Idempotent within a single session: calling `finalize` twice is an
   * error (the dir may have been removed by the first call). The
   * `BackupFinalizedError` is exported for callers to recognise.
   */
  async finalize(opts: { compress: boolean }): Promise<BackupFinalizeResult> {
    if (this.finalized) {
      throw new BackupFinalizedError();
    }
    this.finalized = true;

    if (this.entries.size === 0) {
      // No files were snapshotted. Clean up the empty directory we
      // pre-created in `beginBackup` so the backup root stays tidy.
      await fs.rm(this.dir, { recursive: true, force: true });
      return {};
    }

    if (!opts.compress) {
      return { dirPath: this.dir };
    }

    const archivePath = this.dir + '.tar.gz';
    // Tar from the parent so the archive contains entries rooted at
    // `<timestamp>/...`. This makes `tar.extract` reproduce the same
    // layout the loose tree had.
    const parentDir = path.dirname(this.dir);
    const baseName = path.basename(this.dir);
    await tar.create(
      {
        gzip: true,
        file: archivePath,
        cwd: parentDir,
        portable: true
      },
      [baseName]
    );
    await fs.rm(this.dir, { recursive: true, force: true });
    return { archivePath };
  }
}

/**
 * Outcome of {@link BackupSession.finalize}. Exactly one of the two
 * fields is populated on a non-empty session; both are absent if the
 * session had no snapshots.
 */
export type BackupFinalizeResult = {
  archivePath?: string;
  dirPath?: string;
};

/**
 * Thrown by {@link BackupSession} if the caller tries to use it after
 * {@link BackupSession.finalize} has run.
 */
export class BackupFinalizedError extends Error {
  constructor() {
    super('BackupSession has already been finalized.');
    this.name = 'BackupFinalizedError';
  }
}

/**
 * Begin a new backup run.
 *
 * `rootDir` is the user-configured backup root (e.g.
 * `%LOCALAPPDATA%\df-syncer-windows\backups`). The new run is created as a
 * subfolder named after `timestamp`; if `timestamp` is omitted, a
 * Windows-safe ISO-derived value (no `:` or `.`) is used.
 *
 * The directory is `mkdir -p`ed eagerly so callers can drop the
 * session even if no files end up snapshotted (`finalize` will clean
 * up the empty dir).
 */
export async function beginBackup(rootDir: string, timestamp?: string): Promise<BackupSession> {
  const ts = timestamp ?? buildTimestamp();
  if (ts.includes(path.sep) || ts.includes('/') || ts.includes('..')) {
    throw new Error(`Invalid backup timestamp: ${ts}`);
  }
  const dir = path.join(rootDir, ts);
  await fs.mkdir(dir, { recursive: true });
  return new BackupSession(ts, dir);
}

/**
 * Prune the backup root, keeping only the newest `keepLastN` snapshots
 * (loose folders or `.tar.gz` archives). Items with names that don't
 * match the timestamp shape are left alone — the user might be storing
 * unrelated stuff in there.
 *
 * Returns the absolute paths actually removed, in removal order.
 */
export async function pruneBackups(
  rootDir: string,
  keepLastN: number
): Promise<{ removed: string[] }> {
  if (!Number.isFinite(keepLastN) || keepLastN < 0) {
    throw new Error(`pruneBackups: keepLastN must be a non-negative integer, got ${keepLastN}`);
  }

  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      return { removed: [] };
    }
    throw err;
  }

  const candidates: BackupCandidate[] = [];
  for (const dirent of dirents) {
    const ts = parseBackupName(dirent.name);
    if (!ts) continue;
    candidates.push({
      name: dirent.name,
      timestamp: ts,
      isDirectory: dirent.isDirectory()
    });
  }

  // Newest first.
  candidates.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const toRemove = candidates.slice(keepLastN);
  const removed: string[] = [];
  for (const cand of toRemove) {
    const abs = path.join(rootDir, cand.name);
    try {
      if (cand.isDirectory) {
        await fs.rm(abs, { recursive: true, force: true });
      } else {
        await fs.unlink(abs);
      }
      removed.push(abs);
    } catch (err) {
      // Don't let one stuck file prevent the rest from being pruned;
      // leave it for the next run. We swallow ENOENT explicitly.
      if (isNodeErrnoException(err) && err.code === 'ENOENT') continue;
      throw err;
    }
  }
  return { removed };
}

type BackupCandidate = {
  name: string;
  /** Same shape as {@link buildTimestamp} produces; lexicographic === chronological. */
  timestamp: string;
  isDirectory: boolean;
};

/**
 * The Windows-safe timestamp shape we use for backup names:
 * `YYYY-MM-DDTHH-MM-SS-mmmZ`. This is `Date#toISOString()` with the
 * two illegal-on-NTFS characters (`:` and `.`) replaced by `-` so the
 * names lexicographically sort the same as the underlying instants.
 *
 * Exported so tests and callers can build deterministic stamps.
 */
export function buildTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

const BACKUP_NAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(\.tar\.gz)?$/;

/**
 * Returns the `<timestamp>` portion of a backup name, or `null` if the
 * name doesn't look like one of ours. Both loose dirs (`<ts>`) and
 * compressed archives (`<ts>.tar.gz`) are recognised.
 */
function parseBackupName(name: string): string | null {
  const m = BACKUP_NAME_RE.exec(name);
  return m ? m[1] : null;
}

async function copyDirectoryRecursive(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      const fh = await fs.open(dstPath, 'wx');
      try {
        await pipeline(createReadStream(srcPath), fh.createWriteStream());
      } finally {
        await fh.close();
      }
    }
    // Symlinks/sockets/etc. are intentionally skipped. DF data trees
    // don't contain them; if they do, the user is doing something
    // unusual and we'd rather not silently chase them.
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
