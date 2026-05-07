import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppConfig, LogEntry, LogTailSubscription } from '../../src/shared/types';
import { SettingsModal } from '../../src/renderer/components/main/SettingsModal';
import { LogViewer } from '../../src/renderer/components/main/LogViewer';

/**
 * Renderer tests for Phase 11 — settings modal + log viewer.
 *
 * Mocks `window.df` directly. Each test installs a fresh bridge.
 */

const SAMPLE_CONFIG: AppConfig = {
  schemaVersion: 1,
  cloudFolder: 'C:\\Users\\me\\OneDrive\\df-mirror',
  gameFolder: 'C:\\Users\\me\\AppData\\Roaming\\Bay 12 Games\\Dwarf Fortress',
  enabledFolders: { data: false, mods: true, prefs: true, save: true },
  excludeGlobs: ['**/*.log', '**/Thumbs.db'],
  machineId: 'TEST-PC',
  conflictPolicy: 'newer-wins-backup',
  backup: { keepLastN: 10, compress: true },
  monitor: {
    enabled: true,
    onGameStart: 'prompt-pull',
    onGameExit: 'prompt-push',
    pollIntervalMs: 3000
  },
  startWithWindows: false,
  startMinimizedToTray: false,
  firstRunCompleted: true,
  theme: 'system',
  logLevel: 'info'
};

type LogLineCb = (subId: string, entry: LogEntry) => void;

type SettingsMock = {
  config: {
    get: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    isFirstRun: ReturnType<typeof vi.fn>;
  };
  app: {
    quit: ReturnType<typeof vi.fn>;
    openLogsFolder: ReturnType<typeof vi.fn>;
    openBackupsFolder: ReturnType<typeof vi.fn>;
    openExternal: ReturnType<typeof vi.fn>;
    getVersion: ReturnType<typeof vi.fn>;
    hostname: ReturnType<typeof vi.fn>;
    setStartWithWindows: ReturnType<typeof vi.fn>;
  };
  logs: {
    tail: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    onLine: ReturnType<typeof vi.fn>;
    setLevel: ReturnType<typeof vi.fn>;
    getLevel: ReturnType<typeof vi.fn>;
  };
  menu: {
    onSettingsOpen: ReturnType<typeof vi.fn>;
    onLogsOpen: ReturnType<typeof vi.fn>;
    onSyncTrigger: ReturnType<typeof vi.fn>;
  };
};

function installMock(
  overrides: {
    saveImpl?: (patch: Partial<AppConfig>) => Promise<{ ok: true; data: AppConfig } | { ok: false; error: string }>;
    version?: string;
    setStartImpl?: (...args: unknown[]) => Promise<{ ok: true; data: undefined }>;
    onLineCapture?: { current: LogLineCb | null };
    tailRecent?: LogEntry[];
    tailId?: string;
  } = {}
): SettingsMock {
  const onLineCapture = overrides.onLineCapture;
  const mock: SettingsMock = {
    config: {
      get: vi.fn().mockResolvedValue({ ok: true, data: SAMPLE_CONFIG }),
      save: vi.fn(async (patch: Partial<AppConfig>) => {
        if (overrides.saveImpl) return overrides.saveImpl(patch);
        return { ok: true, data: { ...SAMPLE_CONFIG, ...patch } };
      }),
      isFirstRun: vi.fn().mockResolvedValue({ ok: true, data: false })
    },
    app: {
      quit: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      openLogsFolder: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      openBackupsFolder: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      openExternal: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      getVersion: vi.fn().mockResolvedValue({ ok: true, data: overrides.version ?? '1.0.0' }),
      hostname: vi.fn().mockResolvedValue({ ok: true, data: 'TEST-PC' }),
      setStartWithWindows: vi.fn(async (...args: unknown[]) => {
        if (overrides.setStartImpl) return overrides.setStartImpl(...args);
        return { ok: true, data: undefined };
      })
    },
    logs: {
      tail: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          id: overrides.tailId ?? 'tail-1',
          recent: overrides.tailRecent ?? []
        } satisfies LogTailSubscription
      }),
      unsubscribe: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      onLine: vi.fn((cb: LogLineCb) => {
        if (onLineCapture) onLineCapture.current = cb;
        return () => {
          if (onLineCapture) onLineCapture.current = null;
        };
      }),
      setLevel: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      getLevel: vi.fn().mockResolvedValue({ ok: true, data: 'info' })
    },
    menu: {
      onSettingsOpen: vi.fn(() => () => undefined),
      onLogsOpen: vi.fn(() => () => undefined),
      onSyncTrigger: vi.fn(() => () => undefined)
    }
  };
  Object.defineProperty(window, 'df', {
    value: mock,
    writable: true,
    configurable: true
  });
  return mock;
}

/* ───────────────── SettingsModal tests ───────────────── */

describe('SettingsModal — General tab', () => {
  beforeEach(() => {
    installMock();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders with current config values prefilled', () => {
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const input = screen.getByTestId('settings-machineid-input') as HTMLInputElement;
    expect(input.value).toBe('TEST-PC');
    // Save button starts disabled (no changes yet).
    expect((screen.getByTestId('settings-general-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows error for invalid machineId; valid input enables Save', async () => {
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = screen.getByTestId('settings-machineid-input') as HTMLInputElement;

    await user.clear(input);
    await user.type(input, 'bad name'); // space is invalid
    await waitFor(() => {
      expect(screen.getByTestId('settings-machineid-error')).not.toBeNull();
    });
    expect((screen.getByTestId('settings-general-save') as HTMLButtonElement).disabled).toBe(true);

    await user.clear(input);
    await user.type(input, 'NEW-PC.01');
    await waitFor(() => {
      expect((screen.getByTestId('settings-general-save') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByTestId('settings-machineid-error')).toBeNull();
  });

  it('Save calls api.config.save with the right patch', async () => {
    const mock = installMock();
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const user = userEvent.setup();

    const input = screen.getByTestId('settings-machineid-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'NEW-PC');

    const save = await screen.findByTestId('settings-general-save');
    await user.click(save);

    await waitFor(() => {
      expect(mock.config.save).toHaveBeenCalled();
    });
    const arg = mock.config.save.mock.calls[0][0] as Partial<AppConfig>;
    expect(arg.machineId).toBe('NEW-PC');
    expect(arg.theme).toBe('system');
  });

  it('Cancel discards changes', async () => {
    const onClose = vi.fn();
    const mockSettings = installMock();
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={onClose} />);
    const user = userEvent.setup();

    const input = screen.getByTestId('settings-machineid-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'NEW-PC');

    // The modal asks for confirmation when dirty.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByTestId('settings-modal-close'));
    expect(confirm).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(mockSettings.config.save).not.toHaveBeenCalled();
  });
});

describe('SettingsModal — Excludes tab', () => {
  beforeEach(() => {
    installMock();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('flags an invalid glob with a ✗ marker', async () => {
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('settings-tab-excludes'));
    const ta = screen.getByTestId('settings-excludes-textarea') as HTMLTextAreaElement;
    // Use an unbalanced bracket that picomatch.makeRe should refuse.
    // userEvent.type interprets `[` as a keyboard descriptor, so use
    // fireEvent.change for raw text injection instead.
    fireEvent.change(ta, { target: { value: '**/[invalid' } });

    await waitFor(() => {
      // picomatch v4 errors on `[`-without-`]`, so the marker should appear.
      const invalid = screen.queryByTestId('settings-excludes-invalid-0');
      expect(invalid).not.toBeNull();
    });
    expect((screen.getByTestId('settings-excludes-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Reset to defaults repopulates the textarea', async () => {
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('settings-tab-excludes'));
    const ta = screen.getByTestId('settings-excludes-textarea') as HTMLTextAreaElement;
    await user.clear(ta);
    expect(ta.value).toBe('');

    await user.click(screen.getByTestId('settings-excludes-reset'));
    await waitFor(() => {
      expect(ta.value).toContain('**/*.log');
      expect(ta.value).toContain('df-syncer-windows/**');
    });
  });
});

describe('SettingsModal — About tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the version from api.app.getVersion (mocked)', async () => {
    installMock({ version: '9.9.9-test' });
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('settings-tab-about'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-about-version').textContent).toContain('9.9.9-test');
    });
  });

  it('Open Logs / Backups buttons call IPC', async () => {
    const mock = installMock();
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('settings-tab-about'));
    await user.click(await screen.findByTestId('settings-open-logs'));
    await waitFor(() => {
      expect(mock.app.openLogsFolder).toHaveBeenCalled();
    });

    await user.click(screen.getByTestId('settings-open-backups'));
    await waitFor(() => {
      expect(mock.app.openBackupsFolder).toHaveBeenCalled();
    });
  });
});

describe('SettingsModal — Monitor tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('Save sends monitor patch with new poll interval', async () => {
    const mock = installMock();
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('settings-tab-monitor'));
    const input = screen.getByTestId('settings-poll-interval') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '5000');

    await user.click(screen.getByTestId('settings-monitor-save'));
    await waitFor(() => {
      expect(mock.config.save).toHaveBeenCalled();
    });
    const arg = mock.config.save.mock.calls[0][0] as Partial<AppConfig>;
    expect(arg.monitor?.pollIntervalMs).toBe(5000);
  });

  it('Out-of-range poll interval disables Save and shows error', async () => {
    installMock();
    render(<SettingsModal config={SAMPLE_CONFIG} onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('settings-tab-monitor'));
    const input = screen.getByTestId('settings-poll-interval') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '100'); // below the 500 minimum

    await waitFor(() => {
      expect((screen.getByTestId('settings-monitor-save') as HTMLButtonElement).disabled).toBe(
        true
      );
    });
  });
});

/* ───────────────── LogViewer tests ───────────────── */

describe('LogViewer', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('subscribes on open and renders pushed lines', async () => {
    const capture: { current: LogLineCb | null } = { current: null };
    const initial: LogEntry[] = [
      { ts: '2026-05-07T10:00:00.000Z', level: 'info', message: 'hello' }
    ];
    installMock({ onLineCapture: capture, tailRecent: initial, tailId: 'tail-7' });

    render(<LogViewer open={true} onClose={vi.fn()} />);

    // Initial recent entry rendered.
    await waitFor(() => {
      expect(screen.getByTestId('log-viewer-list').textContent).toContain('hello');
    });

    // Push three more lines; they should render (info filter accepts info+).
    await waitFor(() => {
      expect(capture.current).not.toBeNull();
    });
    if (!capture.current) throw new Error('no callback');
    capture.current('tail-7', { ts: '2026-05-07T10:00:01.000Z', level: 'info', message: 'one' });
    capture.current('tail-7', { ts: '2026-05-07T10:00:02.000Z', level: 'warn', message: 'two' });
    capture.current('tail-7', { ts: '2026-05-07T10:00:03.000Z', level: 'error', message: 'three' });

    await waitFor(() => {
      const list = screen.getByTestId('log-viewer-list');
      expect(list.textContent).toContain('one');
      expect(list.textContent).toContain('two');
      expect(list.textContent).toContain('three');
    });
  });

  it('ignores lines for other subscriptions', async () => {
    const capture: { current: LogLineCb | null } = { current: null };
    installMock({ onLineCapture: capture, tailRecent: [], tailId: 'tail-mine' });

    render(<LogViewer open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(capture.current).not.toBeNull();
    });
    if (!capture.current) throw new Error('no callback');
    capture.current('other-sub', {
      ts: '2026-05-07T10:00:00.000Z',
      level: 'info',
      message: 'should-not-appear'
    });

    // Use a brief delay to verify no render happens.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('log-viewer-list').textContent).not.toContain('should-not-appear');
  });
});
