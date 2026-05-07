/**
 * Atomic filesystem primitives.
 *
 * Every destructive operation that the sync engine performs goes through
 * these helpers. The contract is simple: either the target path ends up
 * with the new content (or removed, for {@link atomicDelete}), or it is
 * left exactly as it was, with at most a sidecar artifact (`*.df-syncer-windows.tmp`
 * or `*.df-syncer-windows.del`) for the caller to clean up on the next pass.
 *
 * Windows quirks handled here:
 * - `fs.rename` can fail with `EPERM` when another process (Defender,
 *   the cloud client, an explorer preview) briefly holds an open handle
 *   on the destination. We retry a small number of times with a short
 *   backoff before surrendering.
 * - We always `fsync` the temp file before rename so that a crash between
 *   the rename and the OS flushing the journal does not leave a renamed
 *   but empty file at the destination.
 *
 * No `Result` wrappers are used here — callers (Phase 6) are inside the
 * main process and `try/catch` for failures.
 */

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Suffix for the temporary write companion. Always lives next to the
 * target, never in the OS temp dir, so the rename below is always
 * intra-volume (rename across volumes is not atomic on any platform).
 */
export const TMP_SUFFIX = '.df-syncer-windows.tmp';

/**
 * Suffix used by {@link atomicDelete}. The rename happens first, the
 * unlink second, so a crash between the two leaves a recoverable
 * artifact at `<target>.df-syncer-windows.del`.
 */
export const DEL_SUFFIX = '.df-syncer-windows.del';

/** Number of times {@link atomicWrite}/{@link atomicCopy} retry the rename on Windows EPERM. */
const RENAME_RETRY_COUNT = 3;

/** Backoff between rename retries, in milliseconds. */
const RENAME_RETRY_BACKOFF_MS = 100;

/**
 * Subset of the Node `error.code` we react to during rename. Centralised
 * here so the test suite can reference the same symbol.
 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Write `source` to `targetPath` atomically.
 *
 * Implementation:
 * 1. Open `<targetPath>.df-syncer-windows.tmp` for exclusive write.
 * 2. Copy the source into it. For a Buffer, `fh.writeFile`. For a
 *    Readable, pipe into a `createWriteStream` on the same path.
 * 3. `fsync` the file (so a crash between rename and OS flush cannot
 *    leave the destination empty).
 * 4. Rename `.tmp` → target. On Windows EPERM/EACCES/EBUSY, retry up to
 *    {@link RENAME_RETRY_COUNT} times with a {@link RENAME_RETRY_BACKOFF_MS}
 *    backoff.
 *
 * On any failure prior to a successful rename, the `.tmp` file is left
 * in place — the caller may choose to recover (e.g. on next sync the
 * orphan tmp can be unlinked).
 */
export async function atomicWrite(
  targetPath: string,
  source: Buffer | Readable | NodeJS.ReadableStream
): Promise<void> {
  const tmpPath = targetPath + TMP_SUFFIX;

  // Step 1+2: write to the tmp path. Open with `wx` for create-or-fail
  // so that a stale `.tmp` from an earlier crash doesn't silently merge
  // into a new write.
  await unlinkIfExists(tmpPath);

  if (Buffer.isBuffer(source)) {
    const fh = await fs.open(tmpPath, 'wx');
    try {
      await fh.writeFile(source);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } else {
    // Stream path. createWriteStream opens with 'w' by default; we use
    // 'wx' for parity with the Buffer branch.
    const ws = createWriteStream(tmpPath, { flags: 'wx' });
    const readable = source instanceof Readable ? source : Readable.from(source);
    try {
      await pipeline(readable, ws);
    } catch (err) {
      // Best-effort cleanup of the tmp on stream failure; rethrow.
      await unlinkIfExists(tmpPath);
      throw err;
    }
    // Re-open and fsync so that the rename below survives a power loss.
    const fh = await fs.open(tmpPath, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  // Step 4: rename, with EPERM-retry on Windows.
  await renameWithRetry(tmpPath, targetPath);
}

/**
 * Copy `srcPath` to `dstPath` via the same `.tmp + fsync + rename`
 * dance as {@link atomicWrite}. Streams the read so large files don't
 * load fully into memory.
 *
 * Cross-volume copies are supported (the temp lives next to the
 * destination, not the source).
 */
export async function atomicCopy(srcPath: string, dstPath: string): Promise<void> {
  const tmpPath = dstPath + TMP_SUFFIX;
  await unlinkIfExists(tmpPath);

  const rs = createReadStream(srcPath);
  const ws = createWriteStream(tmpPath, { flags: 'wx' });
  try {
    await pipeline(rs, ws);
  } catch (err) {
    await unlinkIfExists(tmpPath);
    throw err;
  }

  const fh = await fs.open(tmpPath, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }

  await renameWithRetry(tmpPath, dstPath);
}

/**
 * Delete `targetPath` in a recoverable way.
 *
 * Renames the file to `<targetPath>.df-syncer-windows.del`, then unlinks. A
 * crash between the rename and the unlink leaves the `.del` artifact
 * for the caller to either restore or remove on the next pass.
 *
 * If `targetPath` does not exist, this is a no-op.
 */
export async function atomicDelete(targetPath: string): Promise<void> {
  let exists = true;
  try {
    await fs.stat(targetPath);
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      exists = false;
    } else {
      throw err;
    }
  }
  if (!exists) return;

  const delPath = targetPath + DEL_SUFFIX;
  // If a previous crash left a `.del`, get rid of it before renaming
  // onto the same name.
  await unlinkIfExists(delPath);
  await renameWithRetry(targetPath, delPath);
  await fs.unlink(delPath);
}

/**
 * Rename with bounded retry on Windows transient errors.
 *
 * On Windows, an `EPERM` (mapped to ERROR_ACCESS_DENIED) is the most
 * common cause of rename failure when a file is briefly opened by
 * Defender for AV scan or by a cloud-drive client doing change
 * detection. EACCES and EBUSY are similar.
 *
 * After {@link RENAME_RETRY_COUNT} failed attempts we re-throw the last
 * error so the caller can decide whether to surface it to the user.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_COUNT; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err)) {
        throw err;
      }
      if (attempt < RENAME_RETRY_COUNT) {
        await sleep(RENAME_RETRY_BACKOFF_MS);
      }
    }
  }
  throw lastErr;
}

function isTransientRenameError(err: unknown): boolean {
  if (!isNodeErrnoException(err)) return false;
  return err.code !== undefined && TRANSIENT_RENAME_CODES.has(err.code);
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') return;
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
