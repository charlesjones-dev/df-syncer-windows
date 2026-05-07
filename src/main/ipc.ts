import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { IPC } from '@shared/ipc-channels';
import type {
  AppConfig,
  DfStateChange,
  DryRunPreview,
  IpcApi,
  LogEntry,
  LogLevel,
  Manifest,
  Result,
  SyncDirection,
  SyncPlan,
  SyncPlanResult,
  SyncProgress,
  SyncResult
} from '@shared/types';
import type { ProcessMonitor } from './process-monitor';
import { detectGameFolder, estimateSize, hostname, validateCloudFolder } from './paths';
import type { ConfigStore } from './store';
import { buildDefaultConfig } from './store';
import { listHistory, openBackupFolder } from './history';
import { getLogger, type Logger } from './logger';
import {
  applyPlan,
  cancelInProgressSync,
  getSyncStatus,
  type ApplyPlanContext
} from './sync/execute';
import { scanFolder } from './sync/scan';
import { buildManifestFromEntries, readCloudManifest, readLastBaseManifest } from './sync/manifest';
import { diff } from './sync/diff';
import { materializePlan } from './sync/diff-applier';

/**
 * Compile-time witness that `IpcApi` is referenceable from the main
 * process. Phase 2 acceptance criterion: the type is reachable from
 * both main and renderer entry files. This `void` assertion keeps the
 * import live without producing dead-code warnings.
 */
void (null as unknown as IpcApi);

/**
 * Wrap an async handler so it always returns a typed `Result`. The
 * renderer-side `api.ts` unwraps and throws; main never lets a raw
 * exception cross the IPC boundary.
 */
function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn().then(
    (data): Result<T> => ({ ok: true, data }),
    (err: unknown): Result<T> => ({ ok: false, error: errorMessage(err) })
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Register all wired IPC handlers.
 *
 * Phase 2 wired `config:*` and `paths:*` (minus `paths:estimateSize`).
 * Phase 8 adds `paths:estimateSize`, `app:hostname`,
 * `app:setStartWithWindows`, and `sync:planDryRun`. The remaining
 * namespaces (`sync:plan/apply/...`, `history:*`, `process:*`) land in
 * later phases.
 *
 * Returns a cleanup function that removes every handler — useful in
 * tests and during hot-reload.
 */
export function registerIpcHandlers(deps: {
  store: ConfigStore;
  /** Optional Phase 10 process monitor; when omitted, `process:*` handlers return idle. */
  monitor?: ProcessMonitor;
  /** Phase 11 logger. When omitted, `getLogger()` returns the singleton. */
  logger?: Logger;
}): () => void {
  const { store, monitor } = deps;
  const logger = deps.logger ?? getLogger();

  // ---- config:* --------------------------------------------------------
  ipcMain.handle(IPC.CONFIG_GET, async () => wrap(async () => store.get()));
  ipcMain.handle(IPC.CONFIG_SAVE, async (_evt, patch: Partial<AppConfig>) =>
    wrap(async () => store.save(patch ?? {}))
  );
  ipcMain.handle(IPC.CONFIG_IS_FIRST_RUN, async () => wrap(async () => store.isFirstRun()));

  // ---- paths:* ---------------------------------------------------------
  ipcMain.handle(IPC.PATHS_DETECT_GAME_FOLDER, async () => wrap(() => detectGameFolder()));
  ipcMain.handle(IPC.PATHS_VALIDATE_CLOUD_FOLDER, async (_evt, p: string) =>
    wrap(() => validateCloudFolder(p))
  );
  ipcMain.handle(IPC.PATHS_PICK_FOLDER, async (evt, label: string) =>
    wrap(async () => {
      const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined;
      const opts: Electron.OpenDialogOptions = {
        title: label || 'Select folder',
        properties: ['openDirectory']
      };
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    })
  );
  ipcMain.handle(IPC.PATHS_ESTIMATE_SIZE, async (_evt, p: string) => wrap(() => estimateSize(p)));

  // ---- app:* (Phase 8 subset) -----------------------------------------
  ipcMain.handle(IPC.APP_HOSTNAME, async () => wrap(async () => hostname()));
  ipcMain.handle(
    IPC.APP_SET_START_WITH_WINDOWS,
    async (_evt, opts: { openAtLogin: boolean; openAsHidden: boolean }) =>
      wrap(async () => {
        const openAtLogin = Boolean(opts?.openAtLogin);
        const openAsHidden = Boolean(opts?.openAsHidden);
        // `setLoginItemSettings` is a no-op in some test/headless
        // contexts; guard so the IPC call still resolves cleanly.
        if (typeof app.setLoginItemSettings === 'function') {
          app.setLoginItemSettings({ openAtLogin, openAsHidden });
        }
      })
  );

  // ---- sync:planDryRun (Phase 8) --------------------------------------
  // Phase 8: a draft-config-driven preview used by wizard Step 7. Phase
  // 6 refactors share the bulk of the work via `buildPlanForConfig` so
  // both code paths produce the same diff against the same primitives.
  ipcMain.handle(IPC.SYNC_PLAN_DRY_RUN, async (_evt, draft: Partial<AppConfig>) =>
    wrap(async () => buildDryRunPreview(draft, store))
  );

  // ---- paths:probeExistingManifest (deferred from Phase 7) ------------
  // Tiny wrapper around `readCloudManifest` so the wizard's Step 2 can
  // surface the "merging with existing mirror" notice without statically
  // linking. Returns `null` when the manifest is missing or unparseable.
  ipcMain.handle(IPC.PATHS_PROBE_EXISTING_MANIFEST, async (_evt, cloudFolder: string) =>
    wrap(async () => probeExistingManifest(cloudFolder))
  );

  // ---- sync:plan / sync:apply / sync:getStatus / sync:cancel ----------
  ipcMain.handle(IPC.SYNC_PLAN, async (_evt, opts: { direction: SyncDirection; dryRun: boolean }) =>
    wrap(async () => buildPlanFromConfig(store, opts.direction))
  );

  ipcMain.handle(IPC.SYNC_APPLY, async (evt, args: { plan: SyncPlan; dryRun?: boolean }) =>
    wrap(async () => runApply(store, evt, args, monitor))
  );

  ipcMain.handle(IPC.SYNC_GET_STATUS, async () => wrap(async () => getSyncStatus()));

  ipcMain.handle(IPC.SYNC_CANCEL, async () =>
    wrap(async () => {
      cancelInProgressSync();
    })
  );

  // ---- history:list / history:openBackupFolder ------------------------
  ipcMain.handle(IPC.HISTORY_LIST, async () =>
    wrap(async () => listHistory(app.getPath('userData')))
  );
  ipcMain.handle(IPC.HISTORY_OPEN_BACKUP_FOLDER, async (_evt, timestamp: string) =>
    wrap(async () => {
      const root = backupRootDir();
      await openBackupFolder(root, timestamp);
    })
  );

  // ---- process:* (Phase 10) -------------------------------------------
  // `process:getDfStatus` is a one-shot read; `process:onStateChange`
  // is implemented as a `webContents.send` broadcast from `main/index.ts`
  // when the monitor emits. The renderer's preload subscribes via
  // `ipcRenderer.on(IPC.PROCESS_ON_STATE_CHANGE, ...)`.
  ipcMain.handle(IPC.PROCESS_GET_DF_STATUS, async () =>
    wrap(async () => {
      if (!monitor) {
        return { running: false } satisfies DfStateChange;
      }
      return monitor.getStatus();
    })
  );

  // ---- app:* (Phase 11) -----------------------------------------------
  ipcMain.handle(IPC.APP_QUIT, async () =>
    wrap(async () => {
      app.quit();
    })
  );
  ipcMain.handle(IPC.APP_OPEN_LOGS_FOLDER, async () =>
    wrap(async () => {
      const dir = logger.getLogsDir();
      const err = await shell.openPath(dir);
      if (err) throw new Error(`Failed to open logs folder: ${err}`);
    })
  );
  ipcMain.handle(IPC.APP_OPEN_BACKUPS_FOLDER, async () =>
    wrap(async () => {
      const dir = backupRootDir();
      const err = await shell.openPath(dir);
      if (err) throw new Error(`Failed to open backups folder: ${err}`);
    })
  );
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, async (_evt, url: string) =>
    wrap(async () => {
      if (!isAllowedExternalUrl(url)) {
        throw new Error(`URL not in allow-list: ${url}`);
      }
      await shell.openExternal(url);
    })
  );
  ipcMain.handle(IPC.APP_GET_VERSION, async () => wrap(async () => app.getVersion()));

  // ---- logs:* (Phase 11) -----------------------------------------------
  // The renderer subscribes by calling `logs:tail`; the handler returns
  // the recent buffer + a subscription id. New lines flow over
  // `logs:tail:line` (a webContents.send broadcast) keyed by the same id.
  // The renderer's preload filters out lines for other ids.
  const logSubs: Map<string, { line: (e: LogEntry) => void }> = new Map();
  ipcMain.handle(
    IPC.LOGS_TAIL,
    async (evt, opts: { fromLines?: number; level?: LogLevel } | undefined) =>
      wrap(async () => {
        const sub = await logger.tail({
          ...(opts?.fromLines !== undefined ? { fromLines: opts.fromLines } : {}),
          ...(opts?.level !== undefined ? { level: opts.level } : {})
        });
        const win = BrowserWindow.fromWebContents(evt.sender);
        const onLine = (entry: LogEntry): void => {
          if (!win || win.isDestroyed()) return;
          try {
            win.webContents.send(IPC.LOGS_TAIL_LINE, sub.id, entry);
          } catch {
            // Swallow — window may be tearing down.
          }
        };
        logger.on('line', onLine);
        logSubs.set(sub.id, { line: onLine });
        // Auto-cleanup if the window is destroyed.
        if (win) {
          win.once('closed', () => {
            const handlers = logSubs.get(sub.id);
            if (handlers) {
              logger.off('line', handlers.line);
              logSubs.delete(sub.id);
            }
            logger.unsubscribe(sub.id);
          });
        }
        return sub;
      })
  );
  ipcMain.handle(IPC.LOGS_UNSUBSCRIBE, async (_evt, id: string) =>
    wrap(async () => {
      const handlers = logSubs.get(id);
      if (handlers) {
        logger.off('line', handlers.line);
        logSubs.delete(id);
      }
      logger.unsubscribe(id);
    })
  );
  ipcMain.handle(IPC.LOGS_SET_LEVEL, async (_evt, level: LogLevel) =>
    wrap(async () => {
      logger.setLevel(level);
      // Persist for future runs.
      try {
        store.save({ logLevel: level });
      } catch {
        // Best-effort; logger setting still applied.
      }
    })
  );
  ipcMain.handle(IPC.LOGS_GET_LEVEL, async () => wrap(async () => logger.getLevel()));

  return (): void => {
    ipcMain.removeHandler(IPC.CONFIG_GET);
    ipcMain.removeHandler(IPC.CONFIG_SAVE);
    ipcMain.removeHandler(IPC.CONFIG_IS_FIRST_RUN);
    ipcMain.removeHandler(IPC.PATHS_DETECT_GAME_FOLDER);
    ipcMain.removeHandler(IPC.PATHS_VALIDATE_CLOUD_FOLDER);
    ipcMain.removeHandler(IPC.PATHS_PICK_FOLDER);
    ipcMain.removeHandler(IPC.PATHS_ESTIMATE_SIZE);
    ipcMain.removeHandler(IPC.PATHS_PROBE_EXISTING_MANIFEST);
    ipcMain.removeHandler(IPC.APP_HOSTNAME);
    ipcMain.removeHandler(IPC.APP_SET_START_WITH_WINDOWS);
    ipcMain.removeHandler(IPC.SYNC_PLAN);
    ipcMain.removeHandler(IPC.SYNC_PLAN_DRY_RUN);
    ipcMain.removeHandler(IPC.SYNC_APPLY);
    ipcMain.removeHandler(IPC.SYNC_GET_STATUS);
    ipcMain.removeHandler(IPC.SYNC_CANCEL);
    ipcMain.removeHandler(IPC.HISTORY_LIST);
    ipcMain.removeHandler(IPC.HISTORY_OPEN_BACKUP_FOLDER);
    ipcMain.removeHandler(IPC.PROCESS_GET_DF_STATUS);
    ipcMain.removeHandler(IPC.APP_QUIT);
    ipcMain.removeHandler(IPC.APP_OPEN_LOGS_FOLDER);
    ipcMain.removeHandler(IPC.APP_OPEN_BACKUPS_FOLDER);
    ipcMain.removeHandler(IPC.APP_OPEN_EXTERNAL);
    ipcMain.removeHandler(IPC.APP_GET_VERSION);
    ipcMain.removeHandler(IPC.LOGS_TAIL);
    ipcMain.removeHandler(IPC.LOGS_UNSUBSCRIBE);
    ipcMain.removeHandler(IPC.LOGS_SET_LEVEL);
    ipcMain.removeHandler(IPC.LOGS_GET_LEVEL);
    for (const [id, handlers] of logSubs) {
      logger.off('line', handlers.line);
      logger.unsubscribe(id);
    }
    logSubs.clear();
  };
}

/**
 * Allow-list for `app.openExternal`. We accept HTTPS URLs to a small set
 * of known hosts: GitHub (the project repo + wiki), the Bay 12 forum,
 * and the DF wiki. Phase 12 may extend this list with the canonical
 * release URL once it's known.
 */
const ALLOWED_EXTERNAL_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'www.github.com',
  'docs.github.com',
  'raw.githubusercontent.com',
  'dwarffortresswiki.org',
  'www.dwarffortresswiki.org',
  'bay12games.com',
  'www.bay12games.com',
  'bay12forums.com',
  'www.bay12forums.com',
  'opensource.org',
  'www.opensource.org'
]);

/**
 * Returns true if `url` is an https URL whose host is in the allow-list.
 * Anything else — `file://`, `javascript:`, http, unknown host — is
 * rejected so the renderer can't trick the main process into opening
 * arbitrary protocols.
 */
export function isAllowedExternalUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_EXTERNAL_HOSTS.has(host);
}

/**
 * Build a dry-run preview against the user's draft config (not yet
 * saved). Phase 8 used a dynamic-import probe so it could ship before
 * the engine landed; Phase 6 has the engine guaranteed and shares the
 * core scan-and-diff with `sync:plan`.
 */
async function buildDryRunPreview(
  draft: Partial<AppConfig>,
  store: ConfigStore
): Promise<DryRunPreview> {
  const effective = mergeDraftWithDefaults(draft, store);
  if (!effective.cloudFolder || !effective.gameFolder) {
    return {
      plan: emptyPlan('full'),
      notes: 'Cloud or game folder not set — pick both to preview the first sync.'
    };
  }
  const planResult = await buildPlanForConfig(effective, 'full');
  return { plan: planResult.plan, ...(planResult.notes ? { notes: planResult.notes } : {}) };
}

/**
 * Plan handler for `sync:plan`. Reads the persisted config and produces
 * the same scan + diff + materialize pipeline the dry-run path uses. The
 * `dryRun` flag in `opts` is documented but ignored at this stage — it
 * applies only to `sync:apply`.
 */
async function buildPlanFromConfig(
  store: ConfigStore,
  direction: SyncDirection
): Promise<SyncPlanResult> {
  const cfg = store.get();
  if (!cfg.cloudFolder || !cfg.gameFolder) {
    return {
      plan: emptyPlan(direction),
      prompts: [],
      notes: 'Cloud or game folder not set — finish the wizard before syncing.'
    };
  }
  return buildPlanForConfig(cfg, direction);
}

/**
 * Shared plan builder. Scans the local game folder + the cloud mirror,
 * reads the base manifest (cloud + last-base merge), runs `diff()`, then
 * `materializePlan()` per the config's conflict policy. Returns the
 * final plan plus prompts the UI should resolve.
 *
 * Side-effect-free: the only file reads are scan + manifest probes; no
 * writes ever. Both `sync:plan` and `sync:planDryRun` use this directly.
 */
async function buildPlanForConfig(
  cfg: AppConfig,
  direction: SyncDirection
): Promise<SyncPlanResult> {
  // Local manifest: walk every enabled DF subfolder.
  const localEntries: Awaited<ReturnType<typeof scanFolder>> = [];
  for (const sub of ['data', 'mods', 'prefs', 'save'] as const) {
    if (!cfg.enabledFolders[sub]) continue;
    const root = path.join(cfg.gameFolder, sub);
    try {
      const subEntries = await scanFolder(root, { excludeGlobs: cfg.excludeGlobs });
      for (const e of subEntries) {
        localEntries.push({ ...e, rel: `${sub}/${e.rel}` });
      }
    } catch {
      // Folder may not exist; skip.
    }
  }
  localEntries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const local = buildManifestFromEntries(localEntries, cfg.machineId);

  // Cloud side: scan `<cloud>/df-syncer-windows/mirror/`.
  const cloudMirror = path.join(cfg.cloudFolder, 'df-syncer-windows', 'mirror');
  let cloudEntries: Awaited<ReturnType<typeof scanFolder>> = [];
  try {
    cloudEntries = await scanFolder(cloudMirror, { excludeGlobs: cfg.excludeGlobs });
  } catch {
    cloudEntries = [];
  }
  const cloud = buildManifestFromEntries(cloudEntries, cfg.machineId);

  // Base = `last-cloud.json` if present (per §5.3); fall back to the
  // canonical cloud manifest only if our locally-cached base is missing
  // (fresh-install on this machine, or wiped userData).
  let base: Manifest | null = null;
  try {
    base = await readLastBaseManifest(app.getPath('userData'));
  } catch {
    base = null;
  }
  if (!base) {
    try {
      base = await readCloudManifest(cfg.cloudFolder);
    } catch {
      base = null;
    }
  }

  const plan = diff(local, cloud, base, {
    direction,
    conflictPolicy: cfg.conflictPolicy
  });

  const materialized = materializePlan(plan, cfg.conflictPolicy);

  return {
    plan: materialized.plan,
    prompts: materialized.prompts.map((p) => ({
      rel: p.rel,
      kind: p.kind,
      options: [...p.options],
      ...(p.snapshotBoth !== undefined ? { snapshotBoth: p.snapshotBoth } : {})
    }))
  };
}

/**
 * Tiny wrapper used by `paths:probeExistingManifest`. Returns the
 * manifest if one exists at `<cloudFolder>/df-syncer-windows/manifest.json`,
 * else `null`.
 */
async function probeExistingManifest(cloudFolder: string): Promise<Manifest | null> {
  if (!cloudFolder) return null;
  try {
    return await readCloudManifest(cloudFolder);
  } catch {
    return null;
  }
}

/**
 * Apply path. Constructs an `ApplyPlanContext` from the persisted
 * config + Electron app paths, wires progress events back to the
 * renderer, and calls `applyPlan`. Returns the structured `SyncResult`.
 */
async function runApply(
  store: ConfigStore,
  evt: Electron.IpcMainInvokeEvent,
  args: { plan: SyncPlan; dryRun?: boolean },
  monitor?: ProcessMonitor
): Promise<SyncResult> {
  const cfg = store.get();
  const abort = new AbortController();
  const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined;

  const ctx: ApplyPlanContext = {
    config: cfg,
    dryRun: Boolean(args.dryRun),
    machineId: cfg.machineId,
    cloudFolder: cfg.cloudFolder,
    gameFolder: cfg.gameFolder,
    userDataDir: app.getPath('userData'),
    backupRootDir: backupRootDir(),
    onProgress: (p: SyncProgress) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.SYNC_ON_PROGRESS, p);
      }
    },
    signal: abort.signal,
    freeBytesProbe: async (cloudFolder) => {
      const v = await validateCloudFolder(cloudFolder);
      return v.freeBytes;
    }
  };

  // Phase 10: silence the process monitor's transitions while the apply
  // runs so the dashboard's badge doesn't flicker if `ps-list`'s
  // observation racing the executor's writes happens to drop a poll.
  if (monitor) monitor.pause();
  const logger = getLogger();
  logger.info('sync.apply: start', {
    planId: args.plan.id,
    direction: args.plan.direction,
    items: args.plan.items.length,
    dryRun: Boolean(args.dryRun)
  });
  try {
    const result = await applyPlan(args.plan, ctx);
    if (result.ok) {
      logger.info('sync.apply: done', {
        planId: result.planId,
        applied: result.applied,
        bytesWritten: result.bytesWritten,
        dryRun: result.dryRun
      });
    } else {
      logger.warn('sync.apply: refused', {
        planId: result.planId,
        errorKind: result.errorKind,
        error: result.error
      });
    }
    return result;
  } catch (err) {
    logger.error('sync.apply: error', {
      planId: args.plan.id,
      error: err instanceof Error ? err.message : String(err)
    });
    throw err;
  } finally {
    if (monitor) monitor.resume();
  }
}

/**
 * Backup root path. Mirrors the §6.6 layout: backups live under
 * `%LOCALAPPDATA%\df-syncer-windows\backups`. We resolve via Electron's app
 * paths so test mains (which patch `app.getPath`) get the right
 * location.
 */
function backupRootDir(): string {
  // `app.getPath('userData')` is `%APPDATA%/df-syncer-windows`; backups want
  // `%LOCALAPPDATA%/df-syncer-windows/backups` per the spec.
  const localAppData = process.env.LOCALAPPDATA;
  const root = localAppData
    ? path.join(localAppData, 'df-syncer-windows', 'backups')
    : path.join(app.getPath('userData'), 'backups');
  return root;
}

function emptyPlan(direction: SyncDirection): SyncPlan {
  return {
    id: 'plan-empty',
    createdAt: new Date().toISOString(),
    direction,
    items: [],
    summary: { pushCount: 0, pullCount: 0, conflictCount: 0, totalBytes: 0 }
  };
}

/**
 * Tray-driven sync: build a plan via `buildPlanForConfig`, refuse if
 * conflict prompts remain (focus the window so the user resolves in
 * the dashboard), apply otherwise. Returns once the apply settles.
 *
 * Exposed for the tray to call directly (it doesn't go through IPC; the
 * tray lives in the main process). Mirrors the dashboard's flow.
 */
export async function runSyncFromTray(args: {
  store: ConfigStore;
  window: BrowserWindow | null;
  direction: SyncDirection;
  monitor?: ProcessMonitor;
}): Promise<SyncResult> {
  const { store, window, direction, monitor } = args;
  const cfg = store.get();
  const planResult = await buildPlanForConfig(cfg, direction);
  if (planResult.prompts.length > 0) {
    // Focus the window and refuse silent-apply; conflict resolution is
    // a user-driven flow, not an auto-push step.
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
      // Best-effort: nudge the renderer to load the plan / show its
      // conflict dialog. The renderer probes for state on focus, so a
      // simple toast post is enough.
      try {
        window.webContents.send(IPC.SYNC_ON_PROGRESS, {
          phase: 'pre-check',
          index: 0,
          total: 0,
          message: `Tray-initiated ${direction} has ${planResult.prompts.length} conflict(s); resolve in the dashboard.`
        } satisfies SyncProgress);
      } catch {
        // Ignore; window may be tearing down.
      }
    }
    throw new Error(
      `Tray sync refused: ${planResult.prompts.length} conflict(s) require user resolution.`
    );
  }
  const abort = new AbortController();
  const ctx: ApplyPlanContext = {
    config: cfg,
    dryRun: false,
    machineId: cfg.machineId,
    cloudFolder: cfg.cloudFolder,
    gameFolder: cfg.gameFolder,
    userDataDir: app.getPath('userData'),
    backupRootDir: backupRootDir(),
    onProgress: (p: SyncProgress) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC.SYNC_ON_PROGRESS, p);
      }
    },
    signal: abort.signal,
    freeBytesProbe: async (cloudFolder) => {
      const v = await validateCloudFolder(cloudFolder);
      return v.freeBytes;
    }
  };
  if (monitor) monitor.pause();
  const logger = getLogger();
  logger.info('sync.apply: start (tray)', {
    planId: planResult.plan.id,
    direction,
    items: planResult.plan.items.length
  });
  try {
    const result = await applyPlan(planResult.plan, ctx);
    if (result.ok) {
      logger.info('sync.apply: done (tray)', {
        planId: result.planId,
        applied: result.applied,
        bytesWritten: result.bytesWritten
      });
    } else {
      logger.warn('sync.apply: refused (tray)', {
        planId: result.planId,
        errorKind: result.errorKind,
        error: result.error
      });
    }
    return result;
  } catch (err) {
    logger.error('sync.apply: error (tray)', {
      planId: planResult.plan.id,
      error: err instanceof Error ? err.message : String(err)
    });
    throw err;
  } finally {
    if (monitor) monitor.resume();
  }
}

/**
 * Bytes the tray's auto-push heuristic compares against the rolling
 * average. Walks the same `buildPlanForConfig` pipeline (no writes).
 * Returns 0 when the plan is empty or the config isn't ready yet.
 */
export async function estimatePlanBytes(args: {
  store: ConfigStore;
  direction: SyncDirection;
}): Promise<number> {
  const cfg = args.store.get();
  if (!cfg.cloudFolder || !cfg.gameFolder) return 0;
  const planResult = await buildPlanForConfig(cfg, args.direction);
  return planResult.plan.summary.totalBytes;
}

function mergeDraftWithDefaults(draft: Partial<AppConfig>, store: ConfigStore): AppConfig {
  // The store may not have been written yet (first run). Use the
  // current persisted config as the base; if the store is empty it's
  // already filled with defaults via `buildDefaultConfig()`.
  const base = store.get() ?? buildDefaultConfig();
  return {
    ...base,
    ...draft,
    schemaVersion: 1,
    enabledFolders: {
      ...base.enabledFolders,
      ...(draft.enabledFolders ?? {})
    },
    backup: {
      ...base.backup,
      ...(draft.backup ?? {})
    },
    monitor: {
      ...base.monitor,
      ...(draft.monitor ?? {})
    }
  };
}
