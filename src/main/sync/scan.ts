/**
 * Filesystem walker + streaming SHA-1 hasher.
 *
 * Phase 3 deliverable. Recursively walks a directory, hashes every
 * eligible file with `crypto.createHash('sha1')` over a read stream,
 * and returns a sorted `FileEntry[]` suitable for direct insertion
 * into a `Manifest`.
 *
 * Excludes are applied via `picomatch` matchers compiled once per
 * call. Exclude patterns are tested against POSIX-style relative
 * paths (forward slashes), even on Windows, so `**\/Thumbs.db`
 * patterns work portably.
 *
 * Symlinks are followed via `fs.realpath`; circular targets are
 * detected via a visited-realpath set and skipped silently.
 *
 * Cancellation is honored via `AbortSignal`: every awaited operation
 * checks `signal.aborted` and throws `Error('aborted')` when set.
 *
 * Files we cannot read (EACCES / EBUSY / etc.) emit a `console.warn`
 * and are skipped — a single locked file should never fail an entire
 * scan, since scans run on live game folders.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import type { FileEntry } from '@shared/types';

/**
 * Options for `scanFolder`.
 */
export interface ScanOptions {
  /** Glob patterns (picomatch syntax) to exclude. Tested against POSIX rel paths. */
  excludeGlobs: string[];
  /** Cancellation. Throws `Error('aborted')` from inside the walker. */
  signal?: AbortSignal;
}

/**
 * Walk `root` recursively, returning a sorted array of `FileEntry`s,
 * one per non-excluded regular file. Each entry's `rel` is relative
 * to `root` and uses POSIX-style forward slashes. SHA-1 is computed
 * by streaming the file contents through `crypto.createHash('sha1')`
 * — never load whole files into memory.
 *
 * Behaviors:
 * - Excludes are matched as POSIX-relative paths against compiled
 *   picomatch matchers. `**\/Thumbs.db`, `df-syncer-windows/**`, `**\/*.log`,
 *   etc. are honored.
 * - Symlinks (file or directory) are resolved via `fs.realpath`. The
 *   resolved real path is recorded in a visited-set so circular
 *   structures terminate.
 * - Files we cannot stat or open are warned about and skipped.
 * - The result is stable: identical inputs produce deep-equal output
 *   (sorted by `rel` ascending using locale-independent comparison).
 *
 * @throws Error('aborted') if `signal.aborted` becomes true mid-walk.
 */
export async function scanFolder(root: string, opts: ScanOptions): Promise<FileEntry[]> {
  const { excludeGlobs, signal } = opts;
  const matchers = compileMatchers(excludeGlobs);
  const visited = new Set<string>();
  const entries: FileEntry[] = [];

  const absRoot = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = await fs.realpath(absRoot);
  } catch {
    rootReal = absRoot;
  }
  visited.add(rootReal);

  const gate = new Semaphore(HASH_CONCURRENCY);
  await walk(absRoot, '', { matchers, signal, visited, entries, gate });

  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

/**
 * Compile every glob into a matcher once. `dot: true` so patterns like
 * `**\/*` also cover dotfiles. We always feed POSIX-style paths in
 * (`toPosix(rel)` below), so no slash-normalization option is needed.
 */
function compileMatchers(globs: string[]): picomatch.Matcher[] {
  return globs.map((g) => picomatch(g, { dot: true }));
}

/**
 * Convert a Windows or POSIX absolute/relative path fragment to POSIX
 * style (forward slashes only). Used for exclude matching and for the
 * `rel` field on `FileEntry`.
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

interface WalkCtx {
  matchers: picomatch.Matcher[];
  signal: AbortSignal | undefined;
  visited: Set<string>;
  entries: FileEntry[];
  /** Global concurrency gate for hash work across the whole tree. */
  gate: Semaphore;
}

/**
 * Tiny FIFO semaphore. `run(fn)` waits for a slot, then awaits `fn()`
 * before releasing. We use it so wide trees can saturate the disk
 * without ballooning open file handles.
 */
class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

function isExcluded(matchers: picomatch.Matcher[], rel: string): boolean {
  for (const m of matchers) {
    if (m(rel)) return true;
  }
  return false;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('aborted');
  }
}

async function walk(absDir: string, relDir: string, ctx: WalkCtx): Promise<void> {
  checkAborted(ctx.signal);

  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`scan: cannot read directory ${absDir}: ${(err as Error).message}`);
    return;
  }

  // Stable order so the recursion is deterministic regardless of fs.
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Two-pass per directory: collect file hashing tasks first, then
  // recurse into subdirectories. Hashing is concurrency-bounded so a
  // wide directory of small files can saturate the disk without us
  // opening thousands of file handles at once. Determinism is preserved
  // because every entry we push carries its own `rel` and we sort the
  // final array by `rel` at the top level.
  const fileTasks: Array<{
    realAbs: string;
    relPosix: string;
    size: number;
    mtimeMs: number;
  }> = [];
  const subdirs: Array<{ realAbs: string; rel: string }> = [];

  for (const dirent of dirents) {
    checkAborted(ctx.signal);

    const childAbs = path.join(absDir, dirent.name);
    const childRel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
    const childRelPosix = toPosix(childRel);

    // Excludes apply to the relative path (so `df-syncer-windows/**` matches a
    // top-level `df-syncer-windows/lock.json`, etc.). We early-exit on directories
    // too, so we never recurse into excluded subtrees.
    if (isExcluded(ctx.matchers, childRelPosix)) {
      continue;
    }

    // Resolve symlinks, then dispatch on the *target* type. `lstat` first
    // so we can detect a symlink without following it; for non-symlinks
    // the cached dirent type is enough.
    let stat: import('node:fs').Stats;
    let realAbs = childAbs;
    try {
      const ls = await fs.lstat(childAbs);
      if (ls.isSymbolicLink()) {
        try {
          realAbs = await fs.realpath(childAbs);
        } catch (err) {
          console.warn(`scan: cannot resolve symlink ${childAbs}: ${(err as Error).message}`);
          continue;
        }
        if (ctx.visited.has(realAbs)) {
          // Circular or already-walked target: skip silently.
          continue;
        }
        try {
          stat = await fs.stat(realAbs);
        } catch (err) {
          console.warn(`scan: cannot stat symlink target ${realAbs}: ${(err as Error).message}`);
          continue;
        }
      } else {
        stat = ls;
      }
    } catch (err) {
      console.warn(`scan: cannot lstat ${childAbs}: ${(err as Error).message}`);
      continue;
    }

    if (stat.isDirectory()) {
      ctx.visited.add(realAbs);
      subdirs.push({ realAbs, rel: childRel });
      continue;
    }

    if (!stat.isFile()) {
      // sockets, fifos, char/block devices: skip.
      continue;
    }

    fileTasks.push({
      realAbs,
      relPosix: childRelPosix,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }

  // Hash files in this directory and recurse into subdirectories with
  // bounded concurrency. We share one global pool across both kinds of
  // work via the `ctx.gate` semaphore so the wide tree doesn't
  // multiply concurrency depth × HASH_CONCURRENCY.
  const fileWorks: Promise<void>[] = fileTasks.map((task) =>
    ctx.gate.run(async () => {
      checkAborted(ctx.signal);
      let sha1: string;
      try {
        sha1 = await hashFile(task.realAbs, ctx.signal);
      } catch (err) {
        if ((err as Error).message === 'aborted') throw err;
        console.warn(`scan: cannot hash ${task.realAbs}: ${(err as Error).message}`);
        return;
      }
      ctx.entries.push({
        rel: task.relPosix,
        size: task.size,
        mtimeMs: task.mtimeMs,
        sha1
      });
    })
  );

  // Recurse into subdirs in parallel as well; the gate keeps overall
  // in-flight I/O bounded regardless of tree shape.
  const dirWorks: Promise<void>[] = subdirs.map((sub) => walk(sub.realAbs, sub.rel, ctx));

  await Promise.all([...fileWorks, ...dirWorks]);
}

/**
 * Maximum concurrent file hashes in-flight at a time. Each hash holds
 * one file descriptor plus a streaming buffer. On Windows the per-file
 * open/stat overhead dominates small-file scans, so a moderate degree
 * of parallelism (8) gives a 3-5x speedup vs. fully sequential without
 * risking ENFILE or saturating the disk queue.
 */
const HASH_CONCURRENCY = 16;

/**
 * Stream the file through SHA-1 using a 64 KiB read buffer. The file
 * is never fully buffered in memory; we feed each chunk into
 * `hash.update` and discard it. A 64 KiB highWaterMark balances
 * per-syscall overhead against memory use, and at this size the
 * Windows file-handle latency dominates anyway.
 *
 * Honors `signal`: a cancelled signal closes the read stream and
 * rejects the promise with `Error('aborted')`.
 */
async function hashFile(absPath: string, signal: AbortSignal | undefined): Promise<string> {
  checkAborted(signal);

  const hash = createHash('sha1');
  const stream = createReadStream(absPath, { highWaterMark: 64 * 1024 });

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        stream.destroy();
        throw new Error('aborted');
      }
      hash.update(chunk as Buffer);
    }
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === 'ABORT_ERR' ||
      (err as Error).name === 'AbortError'
    ) {
      throw new Error('aborted');
    }
    throw err;
  }

  return hash.digest('hex');
}
