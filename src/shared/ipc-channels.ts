/**
 * IPC channel name constants.
 *
 * Imported by `src/main/ipc.ts` (handlers) and `src/preload/index.ts`
 * (renderer-side `ipcRenderer.invoke` calls). Keeping the strings in a
 * single shared module prevents drift between the two sides.
 *
 * Naming convention: `<namespace>:<verb>` matching the `IpcApi` shape.
 */

export const IPC = {
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_IS_FIRST_RUN: 'config:isFirstRun',

  PATHS_DETECT_GAME_FOLDER: 'paths:detectGameFolder',
  PATHS_VALIDATE_CLOUD_FOLDER: 'paths:validateCloudFolder',
  PATHS_PICK_FOLDER: 'paths:pickFolder',
  PATHS_ESTIMATE_SIZE: 'paths:estimateSize',

  SYNC_PLAN: 'sync:plan',
  SYNC_PLAN_DRY_RUN: 'sync:planDryRun',
  SYNC_APPLY: 'sync:apply',
  SYNC_GET_STATUS: 'sync:getStatus',
  SYNC_CANCEL: 'sync:cancel',
  SYNC_ON_PROGRESS: 'sync:onProgress',

  HISTORY_LIST: 'history:list',
  HISTORY_OPEN_BACKUP_FOLDER: 'history:openBackupFolder',

  PATHS_PROBE_EXISTING_MANIFEST: 'paths:probeExistingManifest',

  PROCESS_GET_DF_STATUS: 'process:getDfStatus',
  PROCESS_ON_STATE_CHANGE: 'process:onStateChange',

  APP_QUIT: 'app:quit',
  APP_OPEN_LOGS_FOLDER: 'app:openLogsFolder',
  APP_OPEN_BACKUPS_FOLDER: 'app:openBackupsFolder',
  APP_OPEN_EXTERNAL: 'app:openExternal',
  APP_GET_VERSION: 'app:getVersion',
  APP_HOSTNAME: 'app:hostname',
  APP_SET_START_WITH_WINDOWS: 'app:setStartWithWindows',

  LOGS_TAIL: 'logs:tail',
  LOGS_TAIL_LINE: 'logs:tail:line',
  LOGS_UNSUBSCRIBE: 'logs:unsubscribe',
  LOGS_SET_LEVEL: 'logs:setLevel',
  LOGS_GET_LEVEL: 'logs:getLevel',

  MENU_SETTINGS_OPEN: 'menu:settings:open',
  MENU_LOGS_OPEN: 'menu:logs:open',
  MENU_SYNC_TRIGGER: 'menu:sync:trigger'
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
