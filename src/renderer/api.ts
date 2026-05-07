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
 * Shape of `window.df` as exposed by the preload bridge. The bridge
 * returns wrapped `Result<T>` envelopes; this wrapper unwraps them so
 * call sites can write `const cfg = await api.config.get()` and let
 * errors throw.
 *
 * Phase 2 wired `config` and `paths` (minus `paths:estimateSize`).
 * Phase 8 adds `paths:estimateSize`, `app:hostname`,
 * `app:setStartWithWindows`, and `sync:planDryRun`. Later phases extend
 * the preload bridge; the runtime stubs in this file throw a clear
 * error if a not-yet-implemented namespace is invoked.
 */

type WrappedBridge = {
  config: {
    get(): Promise<Result<AppConfig>>;
    save(patch: Partial<AppConfig>): Promise<Result<AppConfig>>;
    isFirstRun(): Promise<Result<boolean>>;
  };
  paths: {
    detectGameFolder(): Promise<Result<string | null>>;
    validateCloudFolder(p: string): Promise<Result<CloudFolderValidation>>;
    pickFolder(label: string): Promise<Result<string | null>>;
    estimateSize(p: string): Promise<Result<EstimateSizeResult>>;
    probeExistingManifest(cloudFolder: string): Promise<Result<Manifest | null>>;
  };
  sync: {
    plan(opts: { direction: SyncDirection; dryRun: boolean }): Promise<Result<SyncPlanResult>>;
    planDryRun(draft: Partial<AppConfig>): Promise<Result<DryRunPreview>>;
    apply(args: { plan: SyncPlan; dryRun?: boolean }): Promise<Result<SyncResult>>;
    getStatus(): Promise<Result<SyncStatus>>;
    cancel(): Promise<Result<void>>;
    onProgress(cb: (p: SyncProgress) => void): () => void;
  };
  history: {
    list(): Promise<Result<SyncHistoryEntry[]>>;
    openBackupFolder(timestamp: string): Promise<Result<void>>;
  };
  process: {
    getDfStatus(): Promise<Result<DfStateChange>>;
    onStateChange(cb: (s: DfStateChange) => void): () => void;
  };
  app: {
    quit(): Promise<Result<void>>;
    openLogsFolder(): Promise<Result<void>>;
    openBackupsFolder(): Promise<Result<void>>;
    openExternal(url: string): Promise<Result<void>>;
    getVersion(): Promise<Result<string>>;
    hostname(): Promise<Result<string>>;
    setStartWithWindows(opts: {
      openAtLogin: boolean;
      openAsHidden: boolean;
    }): Promise<Result<void>>;
  };
  logs: {
    tail(opts?: { fromLines?: number; level?: LogLevel }): Promise<Result<LogTailSubscription>>;
    unsubscribe(id: string): Promise<Result<void>>;
    onLine(cb: (subscriptionId: string, entry: LogEntry) => void): () => void;
    setLevel(level: LogLevel): Promise<Result<void>>;
    getLevel(): Promise<Result<LogLevel>>;
  };
  menu: {
    onSettingsOpen(cb: () => void): () => void;
    onLogsOpen(cb: () => void): () => void;
    onSyncTrigger(cb: (args: { direction: SyncDirection; dryRun: boolean }) => void): () => void;
  };
};

declare global {
  interface Window {
    df: WrappedBridge;
  }
}

function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.data;
  throw new Error(r.error);
}

/**
 * Renderer-side typed wrapper. Phase 11 wires the remaining `app:*`
 * methods, the `logs` namespace, and the `menu` IPC subscription
 * helpers. The `paths.probeExistingManifest` helper is added for
 * Phase 9's "merging with existing mirror" notice in Step 2 /
 * dashboard.
 */
type RendererApi = IpcApi & {
  paths: {
    probeExistingManifest(cloudFolder: string): Promise<Manifest | null>;
  };
  sync: {
    onProgress(cb: (p: SyncProgress) => void): () => void;
  };
  logs: {
    onLine(cb: (subscriptionId: string, entry: LogEntry) => void): () => void;
  };
  menu: {
    onSettingsOpen(cb: () => void): () => void;
    onLogsOpen(cb: () => void): () => void;
    onSyncTrigger(cb: (args: { direction: SyncDirection; dryRun: boolean }) => void): () => void;
  };
};

export const api: RendererApi = {
  config: {
    async get() {
      return unwrap(await window.df.config.get());
    },
    async save(patch) {
      return unwrap(await window.df.config.save(patch));
    },
    async isFirstRun() {
      return unwrap(await window.df.config.isFirstRun());
    }
  },
  paths: {
    async detectGameFolder() {
      return unwrap(await window.df.paths.detectGameFolder());
    },
    async validateCloudFolder(p) {
      return unwrap(await window.df.paths.validateCloudFolder(p));
    },
    async pickFolder(label) {
      return unwrap(await window.df.paths.pickFolder(label));
    },
    async estimateSize(p) {
      return unwrap(await window.df.paths.estimateSize(p));
    },
    async probeExistingManifest(cloudFolder) {
      return unwrap(await window.df.paths.probeExistingManifest(cloudFolder));
    }
  },
  sync: {
    async plan(opts) {
      return unwrap(await window.df.sync.plan(opts));
    },
    async planDryRun(draft) {
      return unwrap(await window.df.sync.planDryRun(draft));
    },
    async apply(args) {
      return unwrap(await window.df.sync.apply(args));
    },
    async getStatus() {
      return unwrap(await window.df.sync.getStatus());
    },
    async cancel() {
      unwrap(await window.df.sync.cancel());
    },
    onProgress: (cb) => window.df.sync.onProgress(cb)
  },
  history: {
    async list() {
      return unwrap(await window.df.history.list());
    },
    async openBackupFolder(timestamp) {
      unwrap(await window.df.history.openBackupFolder(timestamp));
    }
  },
  process: {
    async getDfStatus(): Promise<DfStateChange> {
      return unwrap(await window.df.process.getDfStatus());
    },
    onStateChange(cb: (s: DfStateChange) => void): () => void {
      return window.df.process.onStateChange(cb);
    }
  },
  app: {
    async quit() {
      unwrap(await window.df.app.quit());
    },
    async openLogsFolder() {
      unwrap(await window.df.app.openLogsFolder());
    },
    async openBackupsFolder() {
      unwrap(await window.df.app.openBackupsFolder());
    },
    async openExternal(url) {
      unwrap(await window.df.app.openExternal(url));
    },
    async getVersion() {
      return unwrap(await window.df.app.getVersion());
    },
    async hostname() {
      return unwrap(await window.df.app.hostname());
    },
    async setStartWithWindows(opts) {
      return unwrap(await window.df.app.setStartWithWindows(opts));
    }
  },
  logs: {
    async tail(opts) {
      return unwrap(await window.df.logs.tail(opts));
    },
    async unsubscribe(id) {
      unwrap(await window.df.logs.unsubscribe(id));
    },
    onLine: (cb) => window.df.logs.onLine(cb),
    async setLevel(level) {
      unwrap(await window.df.logs.setLevel(level));
    },
    async getLevel() {
      return unwrap(await window.df.logs.getLevel());
    }
  },
  menu: {
    onSettingsOpen: (cb) => window.df.menu.onSettingsOpen(cb),
    onLogsOpen: (cb) => window.df.menu.onLogsOpen(cb),
    onSyncTrigger: (cb) => window.df.menu.onSyncTrigger(cb)
  }
};
