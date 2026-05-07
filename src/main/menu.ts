/**
 * Application menu — Phase 11.
 *
 * Builds the main process `Menu` template and binds the accelerators
 * required by the spec:
 *
 *  - `Ctrl+,` opens the Settings modal (renderer).
 *  - `Ctrl+L` opens the log viewer (renderer).
 *  - File / Edit / View role-based items.
 *  - Sync menu mirrors the dashboard's four buttons (Pull / Push /
 *    Full Sync / Dry-Run) plus Settings... and Logs...
 *  - Help submenu: Documentation, About, Open Logs Folder, Open Backups
 *    Folder.
 *
 * The module is dependency-light: the calling code (main/index.ts)
 * passes a `MenuDeps` bag with the targets the menu sends events to.
 * The menu only emits IPC events to the renderer or invokes shell
 * helpers — it never reaches into the engine directly.
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { SyncDirection } from '@shared/types';

/** Wiki URL surfaced from the Help menu. Phase 12 fills this in. */
const DOCS_URL = 'https://github.com/charlesjones-dev/df-syncer-windows/wiki';

export type MenuDeps = {
  /** Returns the window the menu should send events to. */
  getWindow(): BrowserWindow | null;
  /**
   * Open the user's logs folder via `shell.openPath`. Wired to the
   * logger's logsDir.
   */
  openLogsFolder(): Promise<void>;
  /**
   * Open the user's backups folder via `shell.openPath`. Wired to the
   * `%LOCALAPPDATA%/df-syncer-windows/backups` location.
   */
  openBackupsFolder(): Promise<void>;
  /**
   * Open the documentation link in the system browser. Defaults to
   * {@link DOCS_URL} if not overridden.
   */
  openDocs?(): Promise<void>;
};

/**
 * Send an IPC event to the renderer. No-ops if the window is gone.
 */
function postToWindow(
  getWindow: () => BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, ...args);
  } catch {
    // Ignore — window may be tearing down.
  }
}

/**
 * Trigger a sync direction via the menu. Sends a `MENU_SYNC_TRIGGER`
 * event the dashboard subscribes to; the dashboard re-uses the same
 * code path it does for tray / button-driven syncs.
 */
function triggerSync(
  getWindow: () => BrowserWindow | null,
  direction: SyncDirection,
  dryRun: boolean
): void {
  postToWindow(getWindow, IPC.MENU_SYNC_TRIGGER, { direction, dryRun });
}

/**
 * Show a small "About" dialog. Uses Electron's built-in dialog
 * (synchronous for compatibility with menu click handlers).
 */
function showAboutDialog(getWindow: () => BrowserWindow | null): void {
  const win = getWindow() ?? undefined;
  const version = app.getVersion();
  void dialog.showMessageBox(win as BrowserWindow, {
    type: 'info',
    title: 'About df-syncer-windows',
    message: 'df-syncer-windows',
    detail:
      `Version ${version}\n\n` +
      'Sync Dwarf Fortress saves, mods, and prefs across PCs via a local\n' +
      'cloud-drive folder.\n\n' +
      `Documentation: ${DOCS_URL}\n` +
      'License: MIT',
    buttons: ['Close']
  });
}

/**
 * Build and apply the application menu. Idempotent — calling repeatedly
 * replaces the previous menu (used by tests and by the settings modal
 * if a future tweak needs to refresh accelerators).
 */
export function installAppMenu(deps: MenuDeps): Menu {
  const { getWindow } = deps;
  const isDev = !app.isPackaged;

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Settings...',
      accelerator: 'CmdOrCtrl+,',
      click: (): void => {
        postToWindow(getWindow, IPC.MENU_SETTINGS_OPEN);
      }
    },
    {
      label: 'Logs...',
      accelerator: 'CmdOrCtrl+L',
      click: (): void => {
        postToWindow(getWindow, IPC.MENU_LOGS_OPEN);
      }
    },
    { type: 'separator' },
    { role: 'quit', accelerator: 'CmdOrCtrl+Q' }
  ];

  const editSubmenu: MenuItemConstructorOptions[] = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' }
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: 'reload', accelerator: 'CmdOrCtrl+R' }
  ];
  if (isDev) {
    viewSubmenu.push({ role: 'toggleDevTools' });
  }

  const syncSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Pull',
      click: (): void => triggerSync(getWindow, 'pull', false)
    },
    {
      label: 'Push',
      click: (): void => triggerSync(getWindow, 'push', false)
    },
    {
      label: 'Full Sync',
      click: (): void => triggerSync(getWindow, 'full', false)
    },
    {
      label: 'Dry-Run',
      click: (): void => triggerSync(getWindow, 'full', true)
    },
    { type: 'separator' },
    {
      label: 'Settings...',
      accelerator: 'CmdOrCtrl+,',
      click: (): void => {
        postToWindow(getWindow, IPC.MENU_SETTINGS_OPEN);
      }
    },
    {
      label: 'Logs...',
      accelerator: 'CmdOrCtrl+L',
      click: (): void => {
        postToWindow(getWindow, IPC.MENU_LOGS_OPEN);
      }
    }
  ];

  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Documentation',
      click: async (): Promise<void> => {
        if (deps.openDocs) {
          try {
            await deps.openDocs();
          } catch {
            // Ignore — best-effort.
          }
        } else {
          try {
            await shell.openExternal(DOCS_URL);
          } catch {
            // Ignore.
          }
        }
      }
    },
    {
      label: 'Open Logs Folder',
      click: async (): Promise<void> => {
        try {
          await deps.openLogsFolder();
        } catch {
          // Ignore.
        }
      }
    },
    {
      label: 'Open Backups Folder',
      click: async (): Promise<void> => {
        try {
          await deps.openBackupsFolder();
        } catch {
          // Ignore.
        }
      }
    },
    { type: 'separator' },
    {
      label: 'About df-syncer-windows',
      click: (): void => {
        showAboutDialog(getWindow);
      }
    }
  ];

  const template: MenuItemConstructorOptions[] = [
    { label: 'File', submenu: fileSubmenu },
    { label: 'Edit', submenu: editSubmenu },
    { label: 'View', submenu: viewSubmenu },
    { label: 'Sync', submenu: syncSubmenu },
    { label: 'Help', submenu: helpSubmenu }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

/** Re-exported for tests/diagnostics. */
export const DOCS_URL_FOR_TESTS = DOCS_URL;
