import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { IPC } from '@shared/ipc-channels';
import type { DfStateChange } from '@shared/types';
import { estimatePlanBytes, registerIpcHandlers, runSyncFromTray } from './ipc';
import { ConfigStore } from './store';
import { AUTO_PUSH_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, ProcessMonitor } from './process-monitor';
import { APP_USER_MODEL_ID, AppTray } from './tray';
import { listHistory } from './history';
import { configureLogger, getLogger, type Logger } from './logger';
import { installAppMenu } from './menu';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let unregisterIpc: (() => void) | null = null;
let processMonitor: ProcessMonitor | null = null;
let appTray: AppTray | null = null;
let monitorListener: ((s: DfStateChange) => void) | null = null;
let logger: Logger | null = null;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Phase 2 verification: a second `pnpm run dev` (or any second
    // launch) lands here and is responsible for surfacing the running
    // window. The duplicate process exits naturally after `app.quit()`
    // above runs in the !gotLock branch.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Windows AppUserModelID is required for `Notification` action
    // buttons to render. Set it before any tray / notification code runs.
    if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
      try {
        app.setAppUserModelId(APP_USER_MODEL_ID);
      } catch {
        // Ignore — best-effort.
      }
    }

    const store = new ConfigStore();
    const config = store.get();

    // Phase 11: configure the logger early so the rest of startup can
    // emit info/warn/error events that get persisted. The logs dir lives
    // under the user-data root per §13 of the implementation plan.
    logger = configureLogger({
      logsDir: path.join(app.getPath('userData'), 'logs'),
      level: config.logLevel ?? 'info',
      mirrorToConsole: isDev
    });
    void logger.pruneOldLogs();
    logger.info('app: ready', {
      version: app.getVersion(),
      platform: process.platform,
      isDev
    });

    // Construct the process monitor first so the IPC layer can return
    // its current status synchronously. Honor `monitor.enabled`: skip
    // the `start()` call but still hand the (idle) instance to IPC so
    // the renderer's `process:getDfStatus` returns a sane default.
    processMonitor = new ProcessMonitor({
      pollIntervalMs: config.monitor.pollIntervalMs,
      cooldownMs:
        config.monitor.onGameExit === 'auto-push' ? AUTO_PUSH_COOLDOWN_MS : DEFAULT_COOLDOWN_MS,
      logger
    });

    unregisterIpc = registerIpcHandlers({ store, monitor: processMonitor, logger });

    createMainWindow();

    // Phase 11: install the application menu. The menu sends IPC events
    // to the renderer (`menu:settings:open`, `menu:logs:open`,
    // `menu:sync:trigger`); the dashboard subscribes to these.
    installAppMenu({
      getWindow: (): BrowserWindow | null => mainWindow,
      openLogsFolder: async (): Promise<void> => {
        const dir = logger?.getLogsDir();
        if (!dir) return;
        const err = await shell.openPath(dir);
        if (err) throw new Error(`Failed to open logs folder: ${err}`);
      },
      openBackupsFolder: async (): Promise<void> => {
        const localAppData = process.env.LOCALAPPDATA;
        const dir = localAppData
          ? path.join(localAppData, 'df-syncer-windows', 'backups')
          : path.join(app.getPath('userData'), 'backups');
        const err = await shell.openPath(dir);
        if (err) throw new Error(`Failed to open backups folder: ${err}`);
      }
    });

    // Tray + monitor wiring happens after the main window exists so
    // `runSyncFromTray` can focus it. The monitor only `start()`s if
    // the user has enabled it in the wizard.
    appTray = new AppTray({
      window: mainWindow,
      monitor: processMonitor,
      config,
      runSync: async (direction) => {
        await runSyncFromTray({
          store,
          window: mainWindow,
          direction,
          monitor: processMonitor ?? undefined
        });
      },
      listHistory: () => listHistory(app.getPath('userData')),
      estimatePlanBytes: (direction) => estimatePlanBytes({ store, direction }),
      logger
    });

    monitorListener = (s: DfStateChange): void => {
      // Phase 11: log monitor state transitions. We log every event for
      // observability — they're low-frequency (DF starts/exits in human
      // time) and useful for diagnosing on-exit prompt issues.
      try {
        getLogger().info('monitor: state-change', {
          running: s.running,
          ...(s.pid !== undefined ? { pid: s.pid } : {}),
          ...(s.prompt !== undefined ? { prompt: s.prompt } : {})
        });
      } catch {
        // Defensive — never let logger I/O fault the monitor wiring.
      }
      // Broadcast to the renderer.
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send(IPC.PROCESS_ON_STATE_CHANGE, s);
        } catch {
          // Window may be tearing down.
        }
      }
      // Update tray UI.
      if (appTray) {
        appTray.updateForState(s.running);
        // Apply the on-start / on-exit policy when the prompt fires.
        // Errors are logged inside applyPolicy but defensively await.
        void appTray.applyPolicy(s);
      }
    };
    processMonitor.on('state-change', monitorListener);

    if (config.monitor.enabled) {
      processMonitor.start();
    }

    // Propagate live config changes (from Settings) to the tray + monitor
    // so the user doesn't have to restart for `monitor.onGameStart`,
    // `pollIntervalMs`, etc. to take effect.
    store.on('change', (next) => {
      try {
        if (appTray) appTray.setConfig(next);
      } catch (err) {
        getLogger().warn('config change → tray.setConfig failed', {
          message: err instanceof Error ? err.message : String(err)
        });
      }
      try {
        if (processMonitor) {
          processMonitor.setPollInterval(next.monitor.pollIntervalMs);
          processMonitor.setCooldownMs(
            next.monitor.onGameExit === 'auto-push' ? AUTO_PUSH_COOLDOWN_MS : DEFAULT_COOLDOWN_MS
          );
          if (next.monitor.enabled) processMonitor.start();
          else processMonitor.stop();
        }
      } catch (err) {
        getLogger().warn('config change → monitor update failed', {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 540,
    title: 'df-syncer-windows',
    show: false,
    autoHideMenuBar: !isDev,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  // Phase 11: the application menu is installed by `installAppMenu()` in
  // `app.whenReady()` — it provides Settings/Logs accelerators and the
  // Sync submenu. The menu auto-hides outside dev mode via
  // `autoHideMenuBar`, but its accelerators (Ctrl+, / Ctrl+L / Ctrl+Q)
  // remain functional.

  // Block any in-app navigation; external links must be explicitly opened.
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  // Disable DevTools in the packaged app: any attempt to open them is closed
  // immediately. In dev mode, DevTools work normally.
  if (!isDev) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase();
      const blockDevtools =
        (input.control && input.shift && key === 'i') ||
        (input.control && input.shift && key === 'j') ||
        (input.control && input.shift && key === 'c') ||
        key === 'f12';
      if (blockDevtools) {
        event.preventDefault();
      }
    });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Prevent any new web contents from navigating to remote URLs or opening new
// windows; restrict shell.openExternal to documented help links only (no-op
// for now since the renderer has no API yet).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // Allow opening explicit external help links via the OS shell.
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  if (logger) {
    try {
      logger.info('app: will-quit');
    } catch {
      // Ignore.
    }
  }
  if (processMonitor && monitorListener) {
    processMonitor.off('state-change', monitorListener);
    monitorListener = null;
  }
  if (processMonitor) {
    processMonitor.dispose();
    processMonitor = null;
  }
  if (appTray) {
    appTray.dispose();
    appTray = null;
  }
  if (unregisterIpc) {
    unregisterIpc();
    unregisterIpc = null;
  }
  if (logger) {
    void logger.flush();
    logger = null;
  }
});
