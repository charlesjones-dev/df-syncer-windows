/**
 * Cloud-side and local-side manifest IO with schema validation.
 *
 * Phase 3 deliverable. Wraps the on-disk JSON manifest files with:
 *
 * - `zod`-driven schema validation on every read (rejects malformed
 *   data, mismatched `schemaVersion`, missing fields).
 * - Atomic writes (`<target>.df-syncer-windows.tmp` → `fsync` → rename) so
 *   a crash mid-write never leaves a half-written manifest. The
 *   rename is the commit point; if a crash happens before it, the
 *   previous valid manifest is intact.
 * - A typed `ManifestSchemaVersionError` for forward-compat handling
 *   in callers that may want to prompt the user to upgrade.
 *
 * The cloud manifest lives at `<cloudFolder>/df-syncer-windows/manifest.json`.
 * The local "last-base" manifest (the snapshot of the cloud as of the
 * last successful sync from this machine) lives at
 * `<userDataDir>/manifests/last-cloud.json` per §5.3 of the
 * implementation plan.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FileEntry, Manifest } from '@shared/types';

/** Current manifest schema version. Bump when fields change. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** Suffix for the temp file used by the atomic-write pattern. */
const TMP_SUFFIX = '.df-syncer-windows.tmp';

/** Cloud-relative location of the canonical cloud manifest. */
const CLOUD_MANIFEST_RELPATH = ['df-syncer-windows', 'manifest.json'] as const;

/** Local-relative location of the cached "last cloud state" manifest. */
const LAST_BASE_MANIFEST_RELPATH = ['manifests', 'last-cloud.json'] as const;

/**
 * Zod schema for `FileEntry`. Mirrors the type in `src/shared/types.ts`.
 * Kept co-located so any change here forces a corresponding type edit.
 */
const FileEntrySchema = z.object({
  rel: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  sha1: z.string().regex(/^[0-9a-f]{40}$/i)
});

/**
 * Zod schema for `Manifest`. The `schemaVersion` literal pins to
 * `MANIFEST_SCHEMA_VERSION` so a wrong version fails validation up
 * front; we surface the mismatch as a typed error in the reader.
 */
const ManifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  generatedAt: z.string(),
  generatedBy: z.string(),
  files: z.array(FileEntrySchema)
});

/**
 * Thrown when a manifest's `schemaVersion` does not match this build's
 * expected version. Callers can branch on `instanceof
 * ManifestSchemaVersionError` to surface a "please upgrade" dialog
 * rather than silently treating the cloud as empty.
 */
export class ManifestSchemaVersionError extends Error {
  public readonly expected: number;
  public readonly got: unknown;

  constructor(expected: number, got: unknown) {
    super(`Manifest schemaVersion mismatch: expected ${expected}, got ${JSON.stringify(got)}`);
    this.name = 'ManifestSchemaVersionError';
    this.expected = expected;
    this.got = got;
  }
}

/**
 * Build an immutable `Manifest` value from a sorted entry list.
 * `generatedAt` is set to the current ISO time; `generatedBy` is the
 * caller-supplied machine id. The entries are not re-sorted here —
 * `scanFolder` already returns them sorted, and re-sorting would
 * mask a bug if it ever didn't.
 */
export function buildManifestFromEntries(entries: FileEntry[], machineId: string): Manifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: machineId,
    files: entries
  };
}

/**
 * Read the cloud manifest at `<cloudFolder>/df-syncer-windows/manifest.json`.
 *
 * Returns `null` if:
 * - The file does not exist (fresh cloud folder; expected on first push).
 * - The file is unparseable JSON (corrupt; conservative — we surface a
 *   warn but don't crash; caller treats as "no base").
 *
 * Throws `ManifestSchemaVersionError` if the JSON is well-formed but
 * the `schemaVersion` is anything other than the current value. This
 * is intentional: a future-version manifest must not be silently
 * overwritten.
 */
export async function readCloudManifest(cloudFolder: string): Promise<Manifest | null> {
  const target = path.join(cloudFolder, ...CLOUD_MANIFEST_RELPATH);
  return readManifestFile(target);
}

/**
 * Atomically write the cloud manifest. Sequence:
 *
 * 1. `mkdir -p <cloudFolder>/df-syncer-windows/`.
 * 2. Write JSON to `<target>.df-syncer-windows.tmp`.
 * 3. `fsync` the temp file (durability across crashes).
 * 4. `rename` temp → target (atomic on the same volume on
 *    Windows/NTFS as well as POSIX).
 *
 * If step 2 or 3 throws, we clean up the temp file. If step 4 throws,
 * the temp may be left behind — the next successful write will
 * overwrite it. Either way, the previous `manifest.json` is intact
 * because we never truncate the destination directly.
 */
export async function writeCloudManifest(cloudFolder: string, m: Manifest): Promise<void> {
  const target = path.join(cloudFolder, ...CLOUD_MANIFEST_RELPATH);
  await writeManifestFile(target, m);
}

/**
 * Read the locally-cached "last cloud state" manifest used as the
 * three-way diff base. Same return-and-throw semantics as
 * `readCloudManifest`.
 */
export async function readLastBaseManifest(userDataDir: string): Promise<Manifest | null> {
  const target = path.join(userDataDir, ...LAST_BASE_MANIFEST_RELPATH);
  return readManifestFile(target);
}

/**
 * Atomically write the local "last cloud state" manifest.
 */
export async function writeLastBaseManifest(userDataDir: string, m: Manifest): Promise<void> {
  const target = path.join(userDataDir, ...LAST_BASE_MANIFEST_RELPATH);
  await writeManifestFile(target, m);
}

/**
 * Internal: read + parse + validate one manifest file. Centralized so
 * cloud and local reads share identical error handling.
 */
async function readManifestFile(target: string): Promise<Manifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Other read errors (EACCES, EISDIR, etc.) → treat as missing but warn.
    console.warn(`manifest: cannot read ${target}: ${(err as Error).message}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`manifest: cannot parse ${target}: ${(err as Error).message}`);
    return null;
  }

  // Schema-version is checked before full schema validation so we can
  // throw a more specific error class. We tolerate the field being any
  // type (number, string, missing) — the typed error captures all of it.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('schemaVersion' in parsed) ||
    (parsed as { schemaVersion: unknown }).schemaVersion !== MANIFEST_SCHEMA_VERSION
  ) {
    const got =
      typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed
        ? (parsed as { schemaVersion: unknown }).schemaVersion
        : undefined;
    throw new ManifestSchemaVersionError(MANIFEST_SCHEMA_VERSION, got);
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`manifest: validation failed for ${target}: ${result.error.message}`);
    return null;
  }
  return result.data;
}

/**
 * Internal: write + fsync + rename one manifest file.
 *
 * On failure during the temp write, attempts to remove the temp file
 * (best-effort) so a future successful write isn't fooled into thinking
 * a partial file is its own temp.
 */
async function writeManifestFile(target: string, m: Manifest): Promise<void> {
  // Re-validate before writing. A schema mismatch at write time is a
  // programmer error; surface it loudly rather than persisting bad data.
  const validated = ManifestSchema.parse(m);

  await fs.mkdir(path.dirname(target), { recursive: true });

  const tmp = `${target}${TMP_SUFFIX}`;
  const json = `${JSON.stringify(validated, null, 2)}\n`;

  // Use a low-level handle so we can `fsync` before rename. `writeFile`
  // does not flush.
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } catch (err) {
    // Best-effort cleanup; ignore errors from the cleanup itself.
    await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await handle.close();

  // Rename is atomic on NTFS as well as POSIX as long as src/dst are on
  // the same volume — they are by construction (both inside `target`'s
  // parent dir).
  await fs.rename(tmp, target);
}
