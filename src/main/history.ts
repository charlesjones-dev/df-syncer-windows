/**
 * Sync history persistence.
 *
 * Each successful (or failed) sync run produces a `SyncHistoryEntry`
 * persisted as a single JSON file under
 * `<userDataDir>/history/<timestamp>.json`. The directory is capped at
 * `HISTORY_KEEP_N` entries; on each write the oldest are pruned so the
 * folder doesn't grow without bound.
 *
 * Phase 6 deliverable. Phase 9 (UI) consumes `listHistory` to render
 * the History panel and `openBackupFolder` from the Backups column.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { shell } from 'electron';
import type { SyncHistoryEntry } from '@shared/types';

/** Maximum number of history entries kept on disk. */
export const HISTORY_KEEP_N = 100;

/** Folder name (under userData) where history entries live. */
const HISTORY_SUBDIR = 'history';

/** Filename pattern: backup timestamp + `.json`. */
const HISTORY_NAME_RE = /^(.+)\.json$/;

/**
 * Append a new history entry to disk. The filename uses
 * `entry.timestamp` (which the executor sets to the same Windows-safe
 * stamp `buildTimestamp()` produced for the backup). Older entries
 * beyond {@link HISTORY_KEEP_N} are pruned.
 */
export async function writeHistoryEntry(
  userDataDir: string,
  entry: SyncHistoryEntry
): Promise<void> {
  const dir = historyDir(userDataDir);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${sanitizeName(entry.timestamp)}.json`);
  // Write directly; an exact-collision is unlikely (millisecond stamp
  // plus single-flight) and overwriting is fine — last writer wins.
  const json = `${JSON.stringify(entry, null, 2)}\n`;
  await fs.writeFile(target, json, 'utf8');

  // Best-effort prune. Failure here is logged but doesn't propagate.
  try {
    await pruneHistory(userDataDir, HISTORY_KEEP_N);
  } catch (err) {
    console.warn(`history: prune failed: ${(err as Error).message}`);
  }
}

/**
 * List all history entries, newest first, up to {@link HISTORY_KEEP_N}.
 *
 * Files that fail to parse are skipped with a warning rather than
 * failing the whole list — the user can still see their other history.
 */
export async function listHistory(userDataDir: string): Promise<SyncHistoryEntry[]> {
  const dir = historyDir(userDataDir);
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const entries: { name: string; entry: SyncHistoryEntry }[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!HISTORY_NAME_RE.test(dirent.name)) continue;
    const abs = path.join(dir, dirent.name);
    let raw: string;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch (err) {
      console.warn(`history: cannot read ${abs}: ${(err as Error).message}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`history: cannot parse ${abs}: ${(err as Error).message}`);
      continue;
    }
    if (!isHistoryEntry(parsed)) {
      console.warn(`history: invalid shape at ${abs}`);
      continue;
    }
    entries.push({ name: dirent.name, entry: parsed });
  }

  // Newest first by timestamp (lex-equals-chronological from
  // `buildTimestamp()`).
  entries.sort((a, b) => {
    const aT = a.entry.timestamp;
    const bT = b.entry.timestamp;
    return aT < bT ? 1 : aT > bT ? -1 : 0;
  });

  return entries.slice(0, HISTORY_KEEP_N).map((e) => e.entry);
}

/**
 * Open the backup folder corresponding to a history entry's timestamp
 * via the OS shell. Tries the `.tar.gz` first (since `compress: true`
 * is the default), then the loose directory.
 *
 * Returns the path that was opened, or `null` if neither exists.
 */
export async function openBackupFolder(
  backupRootDir: string,
  timestamp: string
): Promise<string | null> {
  const archive = path.join(backupRootDir, `${timestamp}.tar.gz`);
  const dir = path.join(backupRootDir, timestamp);

  // Prefer the loose dir if both exist (rare). Loose dir lets the user
  // browse files; the archive needs an extraction step.
  if (await pathExists(dir)) {
    const err = await shell.openPath(dir);
    if (err) throw new Error(`Failed to open backup folder: ${err}`);
    return dir;
  }
  if (await pathExists(archive)) {
    // Open the parent so the user can see the archive next to siblings.
    const err = await shell.openPath(backupRootDir);
    if (err) throw new Error(`Failed to open backup folder: ${err}`);
    return archive;
  }
  return null;
}

/**
 * Prune history entries beyond `keepLastN`, oldest first. Exposed for
 * tests and an explicit "trim history" affordance later; production
 * callers should rely on the implicit prune from {@link writeHistoryEntry}.
 */
export async function pruneHistory(
  userDataDir: string,
  keepLastN: number
): Promise<{ removed: string[] }> {
  if (!Number.isFinite(keepLastN) || keepLastN < 0) {
    throw new Error(`pruneHistory: keepLastN must be non-negative, got ${keepLastN}`);
  }
  const dir = historyDir(userDataDir);
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      return { removed: [] };
    }
    throw err;
  }

  const candidates: { name: string; timestamp: string }[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const m = HISTORY_NAME_RE.exec(dirent.name);
    if (!m) continue;
    candidates.push({ name: dirent.name, timestamp: m[1] });
  }

  // Newest first.
  candidates.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const toRemove = candidates.slice(keepLastN);
  const removed: string[] = [];
  for (const cand of toRemove) {
    const abs = path.join(dir, cand.name);
    try {
      await fs.unlink(abs);
      removed.push(abs);
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === 'ENOENT') continue;
      // Don't let one stuck file abort the prune; surface a warn.
      console.warn(`history: prune unlink failed for ${abs}: ${(err as Error).message}`);
    }
  }
  return { removed };
}

/* ───────────────── helpers ───────────────── */

function historyDir(userDataDir: string): string {
  return path.join(userDataDir, HISTORY_SUBDIR);
}

/**
 * Filenames are restricted to the timestamp shape. We sanitize
 * defensively in case a caller passes something exotic.
 */
function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isHistoryEntry(v: unknown): v is SyncHistoryEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.timestamp === 'string' &&
    typeof o.direction === 'string' &&
    typeof o.result === 'object' &&
    o.result !== null
  );
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
