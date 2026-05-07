/**
 * Phase 3 tests for `manifest.ts`. Covers:
 * - read/write round-trip (deep-equal),
 * - schema-version mismatch raises `ManifestSchemaVersionError`,
 * - corrupt JSON returns null (no crash),
 * - missing file returns null,
 * - atomic-write crash simulation: deleting `.tmp` after writing it
 *   but before rename leaves the previous valid manifest readable,
 * - `buildManifestFromEntries` produces a well-shaped value.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildManifestFromEntries,
  ManifestSchemaVersionError,
  MANIFEST_SCHEMA_VERSION,
  readCloudManifest,
  readLastBaseManifest,
  writeCloudManifest,
  writeLastBaseManifest,
} from '../../src/main/sync/manifest';
import type { FileEntry, Manifest } from '../../src/shared/types';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), `df-syncer-windows-manifest-${randomUUID()}-`));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const FIXTURE_ENTRIES: FileEntry[] = [
  {
    rel: 'mods/dfhack/init.lua',
    size: 7,
    mtimeMs: 1714060800000,
    sha1: '2aae6c35c94fcfb415dbe95f408b9ce91ee846ed',
  },
  {
    rel: 'prefs/announcements.txt',
    size: 1234,
    mtimeMs: 1714060900000,
    sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  },
  {
    rel: 'save/region1/world.sav',
    size: 2_400_000,
    mtimeMs: 1714061000000,
    sha1: '0123456789abcdef0123456789abcdef01234567',
  },
];

function makeManifest(): Manifest {
  return buildManifestFromEntries(FIXTURE_ENTRIES, 'test-machine');
}

describe('buildManifestFromEntries', () => {
  it('produces a well-formed Manifest', () => {
    const m = makeManifest();
    expect(m.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(m.generatedBy).toBe('test-machine');
    expect(m.files).toEqual(FIXTURE_ENTRIES);
    expect(typeof m.generatedAt).toBe('string');
    expect(() => new Date(m.generatedAt).toISOString()).not.toThrow();
  });

  it('does not re-sort entries (the scan already sorts them)', () => {
    // Pass an intentionally-unsorted list to confirm the function does
    // not silently reorder. (If you want sort, you sort.)
    const unsorted = [...FIXTURE_ENTRIES].reverse();
    const m = buildManifestFromEntries(unsorted, 'm');
    expect(m.files).toEqual(unsorted);
  });
});

describe('readCloudManifest / writeCloudManifest — round trip', () => {
  it('returns deep-equal data after write→read', async () => {
    const m = makeManifest();
    await writeCloudManifest(tmp, m);
    const read = await readCloudManifest(tmp);
    expect(read).not.toBeNull();
    expect(read).toEqual(m);
  });

  it('creates df-syncer-windows/manifest.json under the cloud folder', async () => {
    await writeCloudManifest(tmp, makeManifest());
    const stat = await fs.stat(path.join(tmp, 'df-syncer-windows', 'manifest.json'));
    expect(stat.isFile()).toBe(true);
  });

  it('overwrites cleanly on a second write', async () => {
    const first = makeManifest();
    await writeCloudManifest(tmp, first);

    const second: Manifest = {
      ...first,
      generatedBy: 'other-machine',
      files: [FIXTURE_ENTRIES[0]],
    };
    await writeCloudManifest(tmp, second);

    const read = await readCloudManifest(tmp);
    expect(read?.generatedBy).toBe('other-machine');
    expect(read?.files).toHaveLength(1);
  });

  it('returns null when the manifest file does not exist', async () => {
    const read = await readCloudManifest(tmp);
    expect(read).toBeNull();
  });

  it('returns null when the file is not valid JSON', async () => {
    const target = path.join(tmp, 'df-syncer-windows', 'manifest.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'not json {');
    const read = await readCloudManifest(tmp);
    expect(read).toBeNull();
  });
});

describe('readLastBaseManifest / writeLastBaseManifest', () => {
  it('round-trips at <userData>/manifests/last-cloud.json', async () => {
    const m = makeManifest();
    await writeLastBaseManifest(tmp, m);
    const target = path.join(tmp, 'manifests', 'last-cloud.json');
    expect((await fs.stat(target)).isFile()).toBe(true);
    const read = await readLastBaseManifest(tmp);
    expect(read).toEqual(m);
  });

  it('returns null on missing file', async () => {
    expect(await readLastBaseManifest(tmp)).toBeNull();
  });
});

describe('ManifestSchemaVersionError', () => {
  it('throws when schemaVersion is wrong', async () => {
    const target = path.join(tmp, 'df-syncer-windows', 'manifest.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify({
        schemaVersion: 99,
        generatedAt: new Date().toISOString(),
        generatedBy: 'm',
        files: [],
      }),
    );
    await expect(readCloudManifest(tmp)).rejects.toBeInstanceOf(
      ManifestSchemaVersionError,
    );
  });

  it('exposes expected/got fields on the error', async () => {
    const target = path.join(tmp, 'df-syncer-windows', 'manifest.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify({
        schemaVersion: 99,
        generatedAt: 'now',
        generatedBy: 'm',
        files: [],
      }),
    );
    try {
      await readCloudManifest(tmp);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestSchemaVersionError);
      const e = err as ManifestSchemaVersionError;
      expect(e.expected).toBe(MANIFEST_SCHEMA_VERSION);
      expect(e.got).toBe(99);
      expect(e.name).toBe('ManifestSchemaVersionError');
    }
  });

  it('throws when schemaVersion is missing entirely', async () => {
    const target = path.join(tmp, 'df-syncer-windows', 'manifest.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify({ generatedAt: 'now', generatedBy: 'm', files: [] }),
    );
    await expect(readCloudManifest(tmp)).rejects.toBeInstanceOf(
      ManifestSchemaVersionError,
    );
  });
});

describe('atomic-write crash simulation', () => {
  it('a deleted .tmp before rename leaves the previous valid manifest readable', async () => {
    // 1. Write a valid manifest. This is "the previous good state".
    const previous = makeManifest();
    await writeCloudManifest(tmp, previous);

    const target = path.join(tmp, 'df-syncer-windows', 'manifest.json');
    const tmpFile = `${target}.df-syncer-windows.tmp`;

    // 2. Simulate a crash: write a temp file beside the target, then
    //    delete it before the rename ever happens. (We don't even call
    //    writeCloudManifest here — we directly stage the temp file as
    //    the in-progress write would.)
    const inProgress: Manifest = {
      ...previous,
      generatedBy: 'in-progress',
      files: [],
    };
    await fs.writeFile(tmpFile, JSON.stringify(inProgress));
    // The "crash" — we never rename.
    await fs.unlink(tmpFile);

    // 3. Reader should see the previous valid manifest unchanged.
    const read = await readCloudManifest(tmp);
    expect(read).toEqual(previous);
  });

  it('a stale .tmp left behind does not corrupt subsequent reads', async () => {
    // Same as above but the temp survives. The reader should still
    // return the previous valid manifest because the canonical path is
    // unchanged.
    const previous = makeManifest();
    await writeCloudManifest(tmp, previous);

    const target = path.join(tmp, 'df-syncer-windows', 'manifest.json');
    const tmpFile = `${target}.df-syncer-windows.tmp`;
    await fs.writeFile(tmpFile, '{not valid json');

    const read = await readCloudManifest(tmp);
    expect(read).toEqual(previous);
  });
});

describe('write-then-read end-to-end with a no-files manifest', () => {
  it('handles an empty file list', async () => {
    const empty = buildManifestFromEntries([], 'm');
    await writeCloudManifest(tmp, empty);
    const read = await readCloudManifest(tmp);
    expect(read?.files).toEqual([]);
  });
});
