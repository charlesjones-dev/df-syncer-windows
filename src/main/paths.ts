import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CloudFolderValidation, EstimateSizeResult } from '@shared/types';

const execAsync = promisify(exec);

const DF_FOLDER_NAME = 'Dwarf Fortress';

/**
 * Detect the Dwarf Fortress data folder for this machine.
 *
 * Strategy, in order:
 * 1. `%APPDATA%\Bay 12 Games\Dwarf Fortress` — the non-portable Steam
 *    install location.
 * 2. Steam library scan: read `HKCU\Software\Valve\Steam` `SteamPath`
 *    via `reg query`, parse `<SteamPath>\steamapps\libraryfolders.vdf`,
 *    and look for any library containing `steamapps\common\Dwarf
 *    Fortress`. Returns the first match.
 * 3. `null` if neither is present.
 *
 * No exceptions escape; failures fall through to the next strategy.
 */
export async function detectGameFolder(): Promise<string | null> {
  const appData = process.env.APPDATA;
  if (appData) {
    const candidate = path.join(appData, 'Bay 12 Games', 'Dwarf Fortress');
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }

  const steamMatch = await detectViaSteam();
  if (steamMatch) {
    return steamMatch;
  }

  return null;
}

async function detectViaSteam(): Promise<string | null> {
  const steamPath = await readSteamPathFromRegistry();
  if (!steamPath) return null;

  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  let vdf: string;
  try {
    vdf = await fs.readFile(vdfPath, 'utf8');
  } catch {
    // No libraryfolders.vdf — only the Steam install root counts as a library.
    const fallback = path.join(steamPath, 'steamapps', 'common', DF_FOLDER_NAME);
    return (await isDirectory(fallback)) ? fallback : null;
  }

  const libraries = parseLibraryFoldersVdf(vdf);
  // Always also consider the Steam root itself as a library.
  if (!libraries.includes(steamPath)) {
    libraries.unshift(steamPath);
  }

  for (const lib of libraries) {
    const candidate = path.join(lib, 'steamapps', 'common', DF_FOLDER_NAME);
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function readSteamPathFromRegistry(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath');
    // Output looks like:
    //   HKEY_CURRENT_USER\Software\Valve\Steam
    //       SteamPath    REG_SZ    c:/program files (x86)/steam
    const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+?)\s*$/m);
    if (!match) return null;
    const raw = match[1].trim();
    // Steam stores forward-slash paths; normalize to OS separators.
    return path.normalize(raw);
  } catch {
    return null;
  }
}

/**
 * Minimal `libraryfolders.vdf` parser that extracts each library's
 * `path` value. Format example:
 *
 *   "libraryfolders"
 *   {
 *       "0"
 *       {
 *           "path"    "C:\\Program Files (x86)\\Steam"
 *           ...
 *       }
 *       "1"
 *       {
 *           "path"    "D:\\SteamLibrary"
 *           ...
 *       }
 *   }
 *
 * Exported for unit testing.
 */
export function parseLibraryFoldersVdf(text: string): string[] {
  const libraries: string[] = [];
  // Match every `"path"   "<value>"` line; values may contain escaped backslashes.
  const re = /"path"\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].replace(/\\\\/g, '\\');
    libraries.push(path.normalize(raw));
  }
  return libraries;
}

/**
 * Validate a user-picked cloud-mirror folder.
 *
 * Hard-fail (`ok: false`) on:
 * - path missing
 * - path is not a directory
 * - path is not writable
 *
 * Soft-warn (`ok: true` with `reason` populated) when the path lives
 * under `%APPDATA%`, `%LOCALAPPDATA%`, or `Program Files` — those
 * directories are not normally mirrored by cloud clients.
 *
 * On success, `freeBytes` is populated using `fs.statfs` (Node 18.15+);
 * on older runtimes it falls back to `wmic logicaldisk`.
 */
export async function validateCloudFolder(p: string): Promise<CloudFolderValidation> {
  if (!p || typeof p !== 'string') {
    return { ok: false, reason: 'No path provided.' };
  }

  const normalized = path.normalize(p);

  let stat;
  try {
    stat = await fs.stat(normalized);
  } catch {
    return { ok: false, reason: `Path does not exist: ${normalized}` };
  }

  if (!stat.isDirectory()) {
    return { ok: false, reason: `Path is not a directory: ${normalized}` };
  }

  // Writability probe: write a small temp file and remove it.
  const probe = path.join(
    normalized,
    `df-syncer-windows-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    const fh = await fs.open(probe, 'w');
    try {
      await fh.writeFile('df-syncer-windows-write-test');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.unlink(probe);
  } catch {
    // Best-effort cleanup if the file was created but unlink failed.
    try {
      await fs.unlink(probe);
    } catch {
      /* ignore */
    }
    return { ok: false, reason: `Path is not writable: ${normalized}` };
  }

  const freeBytes = await getFreeBytes(normalized);

  const softWarning = detectSoftWarning(normalized);
  if (softWarning) {
    return { ok: true, reason: softWarning, freeBytes };
  }

  return { ok: true, freeBytes };
}

function detectSoftWarning(normalized: string): string | undefined {
  const lower = normalized.toLowerCase();

  const appData = process.env.APPDATA?.toLowerCase();
  const localAppData = process.env.LOCALAPPDATA?.toLowerCase();
  const programFiles = process.env['PROGRAMFILES']?.toLowerCase();
  const programFilesX86 = process.env['PROGRAMFILES(X86)']?.toLowerCase();

  if (appData && lower.startsWith(appData)) {
    return '%APPDATA% is not typically mirrored by cloud clients. Pick a folder inside your cloud-drive root instead.';
  }
  if (localAppData && lower.startsWith(localAppData)) {
    return '%LOCALAPPDATA% is not typically mirrored by cloud clients. Pick a folder inside your cloud-drive root instead.';
  }
  if (
    (programFiles && lower.startsWith(programFiles)) ||
    (programFilesX86 && lower.startsWith(programFilesX86)) ||
    /[a-z]:\\program files( \(x86\))?\\/i.test(normalized)
  ) {
    return 'Program Files is not a cloud-mirrored location. Pick a folder inside your cloud-drive root instead.';
  }

  return undefined;
}

async function getFreeBytes(p: string): Promise<number | undefined> {
  // Prefer fs.statfs (Node 18.15+).
  const fsAny = fs as unknown as {
    statfs?: (p: string) => Promise<{ bsize: number; bavail: number }>;
  };
  if (typeof fsAny.statfs === 'function') {
    try {
      const s = await fsAny.statfs(p);
      return s.bsize * s.bavail;
    } catch {
      /* fall through */
    }
  }

  // Fallback for very old runtimes: shell out to `wmic`. Best-effort.
  if (process.platform === 'win32') {
    try {
      const drive = path.parse(p).root.replace(/\\$/, '');
      const { stdout } = await execAsync(
        `wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`
      );
      const m = stdout.match(/FreeSpace=(\d+)/);
      if (m) return Number(m[1]);
    } catch {
      /* ignore */
    }
  }

  return undefined;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Re-export of the OS hostname helper. Used by the wizard's machine-id
 * step (Phase 8) and surfaced through IPC. Lives here to keep all
 * filesystem/system inquiries colocated.
 */
export function hostname(): string {
  try {
    return os.hostname() || 'this-pc';
  } catch {
    return 'this-pc';
  }
}

/**
 * In-memory cache for `estimateSize`, keyed on the absolute path the
 * caller passed in. Lives for the life of the main process (i.e. the
 * wizard session). Cleared on app quit by virtue of process exit.
 *
 * Phase 8 / wizard Step 4: the wizard re-renders the size estimate
 * every time the user toggles a folder, but the underlying disk doesn't
 * change between paints. Caching avoids re-walking the same folder.
 */
const estimateCache = new Map<string, EstimateSizeResult>();

/**
 * Walk `p` recursively, summing file sizes and counting files. No
 * hashing — this is `du -s`, not `scanFolder`. Symlinks are followed
 * but each real path is counted at most once. Files that can't be
 * stat'd are skipped silently (matches `scanFolder` semantics).
 *
 * Honors `signal` for cancellation: throws `Error('aborted')` if
 * `signal.aborted` becomes true mid-walk.
 *
 * Results are cached per absolute path; pass `bypassCache: true` to
 * force a re-walk (used by the test suite).
 */
export async function estimateSize(
  p: string,
  opts: { signal?: AbortSignal; bypassCache?: boolean } = {}
): Promise<EstimateSizeResult> {
  const absRoot = path.resolve(p);

  if (!opts.bypassCache) {
    const cached = estimateCache.get(absRoot);
    if (cached) return cached;
  }

  const visited = new Set<string>();
  const totals = { bytes: 0, fileCount: 0 };

  try {
    const ls = await fs.lstat(absRoot);
    if (!ls.isDirectory()) {
      // Not a directory — return zero rather than throwing so the
      // wizard's checkbox UI can render "0 B" for missing folders.
      return { bytes: 0, fileCount: 0 };
    }
  } catch {
    return { bytes: 0, fileCount: 0 };
  }

  let rootReal: string;
  try {
    rootReal = await fs.realpath(absRoot);
  } catch {
    rootReal = absRoot;
  }
  visited.add(rootReal);

  await walkSize(absRoot, totals, visited, opts.signal);

  const result: EstimateSizeResult = { ...totals };
  estimateCache.set(absRoot, result);
  return result;
}

async function walkSize(
  dir: string,
  totals: { bytes: number; fileCount: number },
  visited: Set<string>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal?.aborted) {
    throw new Error('aborted');
  }

  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    const childAbs = path.join(dir, dirent.name);
    let stat: import('node:fs').Stats;
    let realAbs = childAbs;
    try {
      const ls = await fs.lstat(childAbs);
      if (ls.isSymbolicLink()) {
        try {
          realAbs = await fs.realpath(childAbs);
        } catch {
          continue;
        }
        if (visited.has(realAbs)) continue;
        try {
          stat = await fs.stat(realAbs);
        } catch {
          continue;
        }
      } else {
        stat = ls;
      }
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      visited.add(realAbs);
      await walkSize(realAbs, totals, visited, signal);
    } else if (stat.isFile()) {
      totals.bytes += stat.size;
      totals.fileCount += 1;
    }
  }
}

/**
 * Clear the estimate-size cache. Exported so tests and a future
 * "rescan" UI affordance can invalidate. Production callers should
 * generally let it persist for the wizard session.
 */
export function clearEstimateSizeCache(): void {
  estimateCache.clear();
}
