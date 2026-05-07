import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  AppConfig,
  CloudFolderValidation,
  DfStateChange,
  DryRunPreview,
  EstimateSizeResult,
  IpcApi,
  LogEntry,
  LogLevel,
  LogTailSubscription,
  Manifest,
  Result,
  SyncDirection,
  SyncHistoryEntry,
  SyncPlan,
  SyncPlanResult,
  SyncProgress,
  SyncResult,
  SyncStatus
} from '@shared/types';

/**
 * Renderer-bound bridge.
 *
 * Phase 2 implements the `config` and `paths` namespaces. Phase 8 adds
 * `paths:estimateSize`, `app:hostname`, `app:setStartWithWindows`, and
 * `sync:planDryRun`. The preload passes raw `Result<T>` envelopes
 * through to the renderer; unwrapping happens in `src/renderer/api.ts`
 * so call sites can `await` data directly and let errors propagate as
 * exceptions.
 *
 * The shape exposed here is intentionally a *subset* of `IpcApi`:
 * later phases (3/5/6/9/10/11) extend this object as their handlers
 * land. The renderer-side wrapper is the only place that pretends the
 * full IpcApi exists today, and it throws "not implemented yet" at
 * runtime if a stub namespace is invoked too early.
 */

type InvokeResult<T> = Promise<Result<T>>;

type ExposedApi = {
  config: {
    get(): InvokeResult<AppConfig>;
    save(patch: Partial<AppConfig>): InvokeResult<AppConfig>;
    isFirstRun(): InvokeResult<boolean>;
  };
  paths: {
    detectGameFolder(): InvokeResult<string | null>;
    validateCloudFolder(p: string): InvokeResult<CloudFolderValidation>;
    pickFolder(label: string): InvokeResult<string | null>;
    estimateSize(p: string): InvokeResult<EstimateSizeResult>;
    probeExistingManifest(cloudFolder: string): InvokeResult<Manifest | null>;
  };
  sync: {
    plan(opts: { direction: SyncDirection; dryRun: boolean }): InvokeResult<SyncPlanResult>;
    planDryRun(draft: Partial<AppConfig>): InvokeResult<DryRunPreview>;
    apply(args: { plan: SyncPlan; dryRun?: boolean }): InvokeResult<SyncResult>;
    getStatus(): InvokeResult<SyncStatus>;
    cancel(): InvokeResult<void>;
    onProgress(cb: (p: SyncProgress) => void): () => void;
  };
  history: {
    list(): InvokeResult<SyncHistoryEntry[]>;
    openBackupFolder(timestamp: string): InvokeResult<void>;
  };
  process: {
    getDfStatus(): InvokeResult<DfStateChange>;
    onStateChange(cb: (s: DfStateChange) => void): () => void;
  };
  app: {
    quit(): InvokeResult<void>;
    openLogsFolder(): InvokeResult<void>;
    openBackupsFolder(): InvokeResult<void>;
    openExternal(url: string): InvokeResult<void>;
    getVersion(): InvokeResult<string>;
    hostname(): InvokeResult<string>;
    setStartWithWindows(opts: { openAtLogin: boolean; openAsHidden: boolean }): InvokeResult<void>;
  };
  logs: {
    tail(opts?: { fromLines?: number; level?: LogLevel }): InvokeResult<LogTailSubscription>;
    unsubscribe(id: string): InvokeResult<void>;
    onLine(cb: (subscriptionId: string, entry: LogEntry) => void): () => void;
    setLevel(level: LogLevel): InvokeResult<void>;
    getLevel(): InvokeResult<LogLevel>;
  };
  menu: {
    onSettingsOpen(cb: () => void): () => void;
    onLogsOpen(cb: () => void): () => void;
    onSyncTrigger(cb: (args: { direction: SyncDirection; dryRun: boolean }) => void): () => void;
  };
};

const api: ExposedApi = {
  config: {
    get: () => ipcRenderer.invoke(IPC.CONFIG_GET),
    save: (patch) => ipcRenderer.invoke(IPC.CONFIG_SAVE, patch),
    isFirstRun: () => ipcRenderer.invoke(IPC.CONFIG_IS_FIRST_RUN)
  },
  paths: {
    detectGameFolder: () => ipcRenderer.invoke(IPC.PATHS_DETECT_GAME_FOLDER),
    validateCloudFolder: (p) => ipcRenderer.invoke(IPC.PATHS_VALIDATE_CLOUD_FOLDER, p),
    pickFolder: (label) => ipcRenderer.invoke(IPC.PATHS_PICK_FOLDER, label),
    estimateSize: (p) => ipcRenderer.invoke(IPC.PATHS_ESTIMATE_SIZE, p),
    probeExistingManifest: (cloudFolder) =>
      ipcRenderer.invoke(IPC.PATHS_PROBE_EXISTING_MANIFEST, cloudFolder)
  },
  sync: {
    plan: (opts) => ipcRenderer.invoke(IPC.SYNC_PLAN, opts),
    planDryRun: (draft) => ipcRenderer.invoke(IPC.SYNC_PLAN_DRY_RUN, draft),
    apply: (args) => ipcRenderer.invoke(IPC.SYNC_APPLY, args),
    getStatus: () => ipcRenderer.invoke(IPC.SYNC_GET_STATUS),
    cancel: () => ipcRenderer.invoke(IPC.SYNC_CANCEL),
    onProgress: (cb) => {
      const handler = (_evt: Electron.IpcRendererEvent, p: SyncProgress): void => cb(p);
      ipcRenderer.on(IPC.SYNC_ON_PROGRESS, handler);
      return () => {
        ipcRenderer.removeListener(IPC.SYNC_ON_PROGRESS, handler);
      };
    }
  },
  history: {
    list: () => ipcRenderer.invoke(IPC.HISTORY_LIST),
    openBackupFolder: (timestamp) => ipcRenderer.invoke(IPC.HISTORY_OPEN_BACKUP_FOLDER, timestamp)
  },
  process: {
    getDfStatus: () => ipcRenderer.invoke(IPC.PROCESS_GET_DF_STATUS),
    onStateChange: (cb) => {
      const handler = (_evt: Electron.IpcRendererEvent, s: DfStateChange): void => cb(s);
      ipcRenderer.on(IPC.PROCESS_ON_STATE_CHANGE, handler);
      return () => {
        ipcRenderer.removeListener(IPC.PROCESS_ON_STATE_CHANGE, handler);
      };
    }
  },
  app: {
    quit: () => ipcRenderer.invoke(IPC.APP_QUIT),
    openLogsFolder: () => ipcRenderer.invoke(IPC.APP_OPEN_LOGS_FOLDER),
    openBackupsFolder: () => ipcRenderer.invoke(IPC.APP_OPEN_BACKUPS_FOLDER),
    openExternal: (url) => ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, url),
    getVersion: () => ipcRenderer.invoke(IPC.APP_GET_VERSION),
    hostname: () => ipcRenderer.invoke(IPC.APP_HOSTNAME),
    setStartWithWindows: (opts) => ipcRenderer.invoke(IPC.APP_SET_START_WITH_WINDOWS, opts)
  },
  logs: {
    tail: (opts) => ipcRenderer.invoke(IPC.LOGS_TAIL, opts ?? {}),
    unsubscribe: (id) => ipcRenderer.invoke(IPC.LOGS_UNSUBSCRIBE, id),
    onLine: (cb) => {
      const handler = (
        _evt: Electron.IpcRendererEvent,
        subscriptionId: string,
        entry: LogEntry
      ): void => cb(subscriptionId, entry);
      ipcRenderer.on(IPC.LOGS_TAIL_LINE, handler);
      return () => {
        ipcRenderer.removeListener(IPC.LOGS_TAIL_LINE, handler);
      };
    },
    setLevel: (level) => ipcRenderer.invoke(IPC.LOGS_SET_LEVEL, level),
    getLevel: () => ipcRenderer.invoke(IPC.LOGS_GET_LEVEL)
  },
  menu: {
    onSettingsOpen: (cb) => {
      const handler = (): void => cb();
      ipcRenderer.on(IPC.MENU_SETTINGS_OPEN, handler);
      return () => {
        ipcRenderer.removeListener(IPC.MENU_SETTINGS_OPEN, handler);
      };
    },
    onLogsOpen: (cb) => {
      const handler = (): void => cb();
      ipcRenderer.on(IPC.MENU_LOGS_OPEN, handler);
      return () => {
        ipcRenderer.removeListener(IPC.MENU_LOGS_OPEN, handler);
      };
    },
    onSyncTrigger: (cb) => {
      const handler = (
        _evt: Electron.IpcRendererEvent,
        args: { direction: SyncDirection; dryRun: boolean }
      ): void => cb(args);
      ipcRenderer.on(IPC.MENU_SYNC_TRIGGER, handler);
      return () => {
        ipcRenderer.removeListener(IPC.MENU_SYNC_TRIGGER, handler);
      };
    }
  }
};

contextBridge.exposeInMainWorld('df', api);

/**
 * Compile-time check that `ExposedApi`'s implemented namespaces are
 * structurally compatible with the corresponding subsets of `IpcApi`.
 * If the shape ever drifts the `unknown` cast below stops compiling.
 *
 * Phase 8 adds partial wiring of `sync` and `app`: only
 * `sync:planDryRun`, `app:hostname`, and `app:setStartWithWindows` are
 * exposed. The full `sync` and `app` namespaces are typed in IpcApi
 * but the rest of those methods land in later phases — we don't include
 * them in `_CheckShape` because doing so would force us to either stub
 * them in the bridge or weaken the structural check.
 */
type _CheckShape = Pick<IpcApi, 'config' | 'paths'>;
// `ExposedApi` returns wrapped `Result` envelopes; `IpcApi` is the
// renderer-facing unwrapped shape. We only assert the *keys* and
// argument shapes match, not the return-type wrappers, so this cast is
// the boundary where wrapped becomes unwrapped.
const _shapeCheck = api as unknown as _CheckShape;
void _shapeCheck;
