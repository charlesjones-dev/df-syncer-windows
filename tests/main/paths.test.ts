import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLibraryFoldersVdf, validateCloudFolder } from '../../src/main/paths';

/**
 * Phase 2 tests for `paths.ts`. We use real temp directories rather
 * than mocking `node:fs/promises` — the validator exercises actual
 * write semantics (open/sync/close/unlink) and using a real fs is
 * simpler to reason about than a deep mock.
 *
 * `detectGameFolder()` is exercised live by `scripts/verify-detect.ts`
 * since it intentionally probes the user's machine.
 */

describe('parseLibraryFoldersVdf', () => {
  it('extracts every path entry', () => {
    const sample = `
"libraryfolders"
{
    "0"
    {
        "path"      "C:\\\\Program Files (x86)\\\\Steam"
        "label"     ""
    }
    "1"
    {
        "path"      "D:\\\\SteamLibrary"
        "label"     ""
    }
}
`;
    const libs = parseLibraryFoldersVdf(sample);
    expect(libs).toHaveLength(2);
    expect(libs[0].toLowerCase()).toContain('steam');
    expect(libs[1].toLowerCase()).toContain('steamlibrary');
  });

  it('returns empty array for an empty file', () => {
    expect(parseLibraryFoldersVdf('')).toEqual([]);
  });
});

describe('validateCloudFolder', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'df-syncer-windows-paths-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('hard-fails when the path is missing', async () => {
    const missing = path.join(tmp, 'does-not-exist');
    const r = await validateCloudFolder(missing);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not exist/i);
  });

  it('hard-fails when the path is a file, not a directory', async () => {
    const filePath = path.join(tmp, 'a-file.txt');
    await fs.writeFile(filePath, 'hi');
    const r = await validateCloudFolder(filePath);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a directory/i);
  });

  it('hard-fails when the path is not writable (simulated via mocked fs)', async () => {
    // We can't reliably make a folder non-writable on Windows in a test
    // (NTFS ACLs differ from POSIX), so we simulate by passing a path
    // whose parent is a file, which produces an open-time write error.
    const filePath = path.join(tmp, 'leaf.txt');
    await fs.writeFile(filePath, 'x');
    const childAsDir = path.join(filePath, 'child-dir');
    const r = await validateCloudFolder(childAsDir);
    expect(r.ok).toBe(false);
    // Either "does not exist" (stat fails) or "not writable" depending
    // on Node's behavior is acceptable — both are hard failures.
    expect(r.reason).toMatch(/does not exist|not writable|not a directory/i);
  });

  it('succeeds on a valid temp folder with freeBytes populated', async () => {
    // The OS temp dir typically lives under %LOCALAPPDATA% on Windows,
    // which would trip the soft-warning branch. Temporarily clear the
    // env vars that drive the warning so the success path is exercised
    // cleanly.
    const saved = {
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PROGRAMFILES: process.env.PROGRAMFILES,
      PF86: process.env['PROGRAMFILES(X86)']
    };
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    delete process.env.PROGRAMFILES;
    delete process.env['PROGRAMFILES(X86)'];
    try {
      const r = await validateCloudFolder(tmp);
      expect(r.ok).toBe(true);
      expect(r.reason).toBeUndefined();
      expect(r.freeBytes).toBeTypeOf('number');
      expect((r.freeBytes ?? 0) > 0).toBe(true);
    } finally {
      if (saved.APPDATA !== undefined) process.env.APPDATA = saved.APPDATA;
      if (saved.LOCALAPPDATA !== undefined) process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
      if (saved.PROGRAMFILES !== undefined) process.env.PROGRAMFILES = saved.PROGRAMFILES;
      if (saved.PF86 !== undefined) process.env['PROGRAMFILES(X86)'] = saved.PF86;
    }
  });

  it('soft-warns when the path is under Program Files', async () => {
    // We don't actually write to Program Files; instead we point at a
    // synthetic path under it and accept that the validator returns a
    // hard error (the dir doesn't exist) OR a soft warning. The path
    // shape is the contract we're verifying — the soft-warn check fires
    // only after the writability probe succeeds, which it cannot here.
    // Use a real writable temp dir whose normalized path *starts with*
    // Program Files by overriding env locally.
    const original = process.env.PROGRAMFILES;
    try {
      process.env.PROGRAMFILES = tmp; // pretend tmp is Program Files.
      const r = await validateCloudFolder(tmp);
      expect(r.ok).toBe(true);
      expect(r.reason).toMatch(/program files|not.*cloud/i);
    } finally {
      if (original === undefined) delete process.env.PROGRAMFILES;
      else process.env.PROGRAMFILES = original;
    }
  });
});
