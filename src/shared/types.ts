/**
 * Cross-process shared type definitions.
 *
 * These types are imported by main, preload, renderer, and tests. They
 * describe the persisted configuration, the manifest schema used for
 * sync, and the IPC contract bridging the renderer to the main process.
 *
 * Phase 2 implements only the `config` and `paths` namespaces of the IPC
 * surface; later phases (3, 5, 6, 8, 10, 11) will register the remaining
 * handlers. Declaring the full `IpcApi` shape now means downstream phases
 * can extend without redefining types.
 */

/**
 * Discriminated-union result wrapper used by every IPC handler.
 *
 * The main process returns a `Result` so that errors are typed and
 * non-throwing across the IPC boundary. The renderer-side `api.ts`
 * unwraps and throws on `ok: false` for ergonomic call sites.
 */
export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E };

/**
 * Direction of a sync operation. `full` runs both push and pull paths.
 */
export type SyncDirection = 'push' | 'pull' | 'full';

/**
 * Conflict-resolution strategy applied when both sides have changed.
 */
export type ConflictPolicy = 'newer-wins-backup' | 'always-prompt' | 'backup-only-no-resolve';

/**
 * Per-folder enable flags for the four DF subdirectories.
 */
export type EnabledFolders = {
  data: boolean;
  mods: boolean;
  prefs: boolean;
  save: boolean;
};

/**
 * Persisted application configuration, owned by the main-process store.
 *
 * Defaults are documented inline; see §5.1 of the implementation plan.
 */
export type AppConfig = {
  schemaVersion: 1;
  /** User-picked cloud-mirror folder. Empty until the wizard finishes. */
  cloudFolder: string;
  /** DF data root, typically `%APPDATA%\Bay 12 Games\Dwarf Fortress`. */
  gameFolder: string;
  enabledFolders: EnabledFolders;
  excludeGlobs: string[];
  /** Stable identifier for this PC (defaults to hostname). */
  machineId: string;
  conflictPolicy: ConflictPolicy;
  backup: {
    keepLastN: number;
    compress: boolean;
  };
  monitor: {
    enabled: boolean;
    onGameStart: 'do-nothing' | 'auto-pull' | 'prompt-pull';
    onGameExit: 'do-nothing' | 'auto-push' | 'prompt-push';
    pollIntervalMs: number;
  };
  startWithWindows: boolean;
  startMinimizedToTray: boolean;
  firstRunCompleted: boolean;
  /** Phase 11: theme preference for the renderer. */
  theme?: ThemePreference;
  /** Phase 11: minimum log level the main-process logger emits. */
  logLevel?: LogLevel;
};

/* ───────────────── Phase 11 additions ───────────────── */

/**
 * User-selectable theme preference. `system` follows OS preference (dark
 * by default if the system signal is unavailable).
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * Logger severity level.
 *
 * `error` < `warn` < `info` < `debug` (lower = more severe). The runtime
 * `level` setting filters out anything *less severe* than configured.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * One log line. The renderer's `<LogViewer/>` consumes these; the
 * main-process logger emits them both to disk and over the
 * `logs:tail:line` IPC subscription channel.
 */
export type LogEntry = {
  /** ISO-8601 timestamp. */
  ts: string;
  level: LogLevel;
  message: string;
  /** Optional structured fields (JSON-serialisable). */
  fields?: Record<string, unknown>;
};

/**
 * Returned by `logs.tail({ fromLines })` once the subscription is set
 * up. `recent` is the most recent lines from today's log; `unsubscribe`
 * is invoked by the renderer to detach when the viewer closes.
 */
export type LogTailSubscription = {
  /** Subscription handle echoed back over `logs:unsubscribe`. */
  id: string;
  /** Most recent N lines from today's log file. */
  recent: LogEntry[];
};

/**
 * One file in a manifest. `rel` is POSIX-style under the mirror root.
 */
export type FileEntry = {
  rel: string;
  size: number;
  mtimeMs: number;
  sha1: string;
};

/**
 * Cloud or local manifest. Phase 3 wires read/write; Phase 4 consumes.
 */
export type Manifest = {
  schemaVersion: 1;
  generatedAt: string;
  generatedBy: string;
  files: FileEntry[];
};

/**
 * Discriminator for plan items. Phase 4 implements the producer.
 *
 * `conflict-local-deleted` / `conflict-cloud-deleted` cover the
 * "missing on one side, modified on the other" case from §6.1.
 */
export type SyncPlanItemKind =
  | 'push'
  | 'pull'
  | 'push-delete'
  | 'pull-delete'
  | 'conflict-newer-local'
  | 'conflict-newer-cloud'
  | 'conflict-tie'
  | 'conflict-local-deleted'
  | 'conflict-cloud-deleted';

/**
 * One row of a `SyncPlan`. Carries enough context for the executor
 * (Phase 6) to act and for the renderer (Phase 9) to render rich
 * tooltips without re-reading the manifests.
 *
 * `bytes` is the size of the file that will actually move:
 * - For pushes: the local file's size.
 * - For pulls: the cloud file's size.
 * - For deletes: the size of the file being removed.
 * - For conflicts: the loser-side size (i.e. the side that will be
 *   backed up before being overwritten). For `conflict-tie` this is
 *   the larger of the two so progress estimates aren't undersized.
 */
export type SyncPlanItem = {
  rel: string;
  kind: SyncPlanItemKind;
  /** Whether the executor will actually apply this in the chosen direction. */
  applied: boolean;
  bytes: number;
  localEntry: FileEntry | null;
  cloudEntry: FileEntry | null;
  baseEntry: FileEntry | null;
  /** Optional human-readable explanation; useful for UI tooltips. */
  notes?: string;
};

export type SyncPlan = {
  id: string;
  createdAt: string;
  direction: SyncDirection;
  items: SyncPlanItem[];
  summary: {
    pushCount: number;
    pullCount: number;
    conflictCount: number;
    totalBytes: number;
  };
};

/**
 * Outcome of an apply-plan call. Populated by Phase 6.
 *
 * `ok` is the discriminator: a successful run returns `ok: true` with
 * filled-in `applied`/`skipped`/`conflicts`/`bytesWritten`; a refused or
 * failed run returns `ok: false` with `errorKind` and `error`.
 */
export type SyncResult = {
  planId: string;
  startedAt: string;
  completedAt: string;
  dryRun: boolean;
  /** Direction the executor ran in. Mirrors the input plan's direction. */
  direction: SyncDirection;
  /** True if every applied item completed; false if refused or aborted. */
  ok: boolean;
  applied: number;
  skipped: number;
  conflicts: SyncPlanItem[];
  bytesWritten: number;
  /** Number of files written into the backup session. */
  backupCount: number;
  /** Path to the backup archive (`.tar.gz`) or loose directory, if any. */
  backupArchivePath?: string;
  backupDirPath?: string;
  /** Timestamp string used for backup + history filenames. */
  backupTimestamp?: string;
  /** Discriminator on `ok: false`. See SyncResultErrorKind. */
  errorKind?: SyncResultErrorKind;
  /** Human-readable error message on `ok: false`. */
  error?: string;
};

/**
 * Categorised error kind on `SyncResult.ok === false`. Matches the
 * thrown error classes in `src/main/sync/execute.ts`.
 */
export type SyncResultErrorKind =
  | 'df-running'
  | 'insufficient-cloud-space'
  | 'lock-held'
  | 'no-config'
  | 'in-progress'
  | 'integrity'
  | 'cancelled'
  | 'unresolved-conflicts'
  | 'unknown';

/**
 * Persisted history entry written after each sync. Phase 6.
 */
export type SyncHistoryEntry = {
  timestamp: string;
  direction: SyncDirection;
  result: SyncResult;
};

/**
 * Live state of the Dwarf Fortress process, broadcast by Phase 10.
 */
export type DfState = {
  running: boolean;
  pid?: number;
  since?: string;
  exePath?: string;
};

/**
 * Snapshot returned by `sync.getStatus()` (Phase 6).
 */
export type SyncStatus = {
  inProgress: boolean;
  currentPlanId?: string;
  startedAt?: string;
  currentPhase?: SyncPhase;
  plannedItems?: number;
  completedItems?: number;
  lastError?: string;
};

/**
 * Coarse-grained phase of the executor's state machine. Surfaced via
 * `sync:getStatus` and `sync:onProgress`.
 */
export type SyncPhase =
  | 'idle'
  | 'pre-check'
  | 'lock'
  | 'backup-begin'
  | 'apply'
  | 'manifest-rebuild'
  | 'manifest-write'
  | 'backup-finalize'
  | 'prune'
  | 'history-write'
  | 'done'
  | 'error';

/**
 * Per-step progress event emitted by `applyPlan` via `onProgress`.
 *
 * `phase` tracks the executor's coarse state; `index`/`total` reflect
 * progress through the apply step (only meaningful while
 * `phase === 'apply'`).
 */
export type SyncProgress = {
  phase: SyncPhase;
  index: number;
  total: number;
  currentRel?: string;
  message?: string;
};

/**
 * Output of `paths.validateCloudFolder`. `ok: true` with a populated
 * `reason` indicates a soft warning the wizard should surface.
 */
export type CloudFolderValidation = {
  ok: boolean;
  reason?: string;
  freeBytes?: number;
};

/**
 * The full IPC contract. Phase 2 implements only `config` and `paths`;
 * the other namespaces are stubbed out in `src/main/ipc.ts` and will be
 * filled in by later phases. The shape is fixed here so that preload
 * and renderer can already type against the final surface.
 */
export type IpcApi = {
  config: {
    get(): Promise<AppConfig>;
    save(patch: Partial<AppConfig>): Promise<AppConfig>;
    isFirstRun(): Promise<boolean>;
  };
  paths: {
    detectGameFolder(): Promise<string | null>;
    validateCloudFolder(p: string): Promise<CloudFolderValidation>;
    pickFolder(label: string): Promise<string | null>;
    estimateSize(p: string): Promise<EstimateSizeResult>;
  };
  sync: {
    plan(opts: { direction: SyncDirection; dryRun: boolean }): Promise<SyncPlanResult>;
    planDryRun(draft: Partial<AppConfig>): Promise<DryRunPreview>;
    apply(args: { plan: SyncPlan; dryRun?: boolean }): Promise<SyncResult>;
    getStatus(): Promise<SyncStatus>;
    cancel(): Promise<void>;
  };
  history: {
    list(): Promise<SyncHistoryEntry[]>;
    openBackupFolder(timestamp: string): Promise<void>;
  };
  process: {
    getDfStatus(): Promise<DfStateChange>;
    onStateChange(cb: (s: DfStateChange) => void): () => void;
  };
  app: {
    quit(): Promise<void>;
    openLogsFolder(): Promise<void>;
    openBackupsFolder(): Promise<void>;
    openExternal(url: string): Promise<void>;
    getVersion(): Promise<string>;
    hostname(): Promise<string>;
    setStartWithWindows(opts: { openAtLogin: boolean; openAsHidden: boolean }): Promise<void>;
  };
  logs: {
    tail(opts?: { fromLines?: number; level?: LogLevel }): Promise<LogTailSubscription>;
    unsubscribe(id: string): Promise<void>;
    onLine(cb: (subscriptionId: string, entry: LogEntry) => void): () => void;
    setLevel(level: LogLevel): Promise<void>;
    getLevel(): Promise<LogLevel>;
  };
};

/* ───────────────── Phase 8 additions ───────────────── */

/**
 * Result of `paths.estimateSize(p)`. Phase 8 / wizard Step 4.
 *
 * Walks the directory recursively summing file sizes (no hashing). The
 * main-process implementation caches results per absolute path within
 * the wizard session.
 */
export type EstimateSizeResult = {
  bytes: number;
  fileCount: number;
};

/**
 * Dry-run preview returned by `sync.planDryRun(draft)`. Phase 8 calls
 * this from wizard Step 7 against the not-yet-saved draft config.
 *
 * When the diff engine is wired (Phase 4 + Phase 6), `plan` is the real
 * plan computed against the on-disk state. While Phase 4/6 are landing,
 * the handler may return a stub `plan` with empty summary and a
 * `notes` field explaining the situation; Step 7 surfaces the note.
 */
export type DryRunPreview = {
  plan: SyncPlan;
  /** Optional explanatory note (e.g. "engine lands in Phase 4/6"). */
  notes?: string;
};

/* ───────────────── Phase 6 additions ───────────────── */

/**
 * Result of `sync:plan(opts)` — pairs a freshly computed plan with the
 * conflict prompts produced by the materializer pass. Phase 6 IPC
 * handler returns this so the renderer can render the prompt dialog
 * before calling `sync:apply` with a fully-resolved plan.
 *
 * `prompts: []` means the plan can be applied directly.
 */
export type SyncPlanResult = {
  plan: SyncPlan;
  prompts: SyncPlanPrompt[];
  notes?: string;
};

/**
 * Renderer-friendly mirror of `ConflictPrompt` from
 * `src/main/sync/diff-applier.ts`. Phase 6 surfaces it across IPC; the
 * dashboard collects user choices and rebuilds the plan before calling
 * `sync:apply`.
 */
export type SyncPlanPrompt = {
  rel: string;
  kind: SyncPlanItemKind;
  options: ('keep-local' | 'keep-cloud' | 'keep-both')[];
  snapshotBoth?: boolean;
};

/* ───────────────── Phase 10 additions ───────────────── */

/**
 * Event payload broadcast over `IPC.PROCESS_ON_STATE_CHANGE` whenever
 * the `ProcessMonitor` observes a transition. The base shape mirrors
 * `DfState`; the optional `prompt` field signals a follow-on UX cue
 * derived from the executor state machine:
 *
 * - `prompt: 'on-exit'` — fired after the cooldown timer expires once
 *   DF has gone from Running → Idle. Carries `running: false`. The tray
 *   uses this to show the "DF closed — push to cloud?" notification.
 * - `prompt: 'on-start'` — fired the moment DF is first observed
 *   running. Carries `running: true`. The tray uses this to show the
 *   "DF launching — pull from cloud?" notification (with a save-loaded
 *   warning baked into the body).
 *
 * The renderer simply renders `running`; the prompt field is for the
 * tray's policy hooks (and is also informational to the dashboard if it
 * wants to surface the cooldown banner).
 */
export type DfStateChange = DfState & {
  prompt?: 'on-start' | 'on-exit';
};
