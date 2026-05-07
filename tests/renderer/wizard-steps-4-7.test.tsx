import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardShell } from '../../src/renderer/components/wizard/WizardShell';
import { Step4SyncSelection } from '../../src/renderer/components/wizard/Step4SyncSelection';
import { Step5MachineIdentity } from '../../src/renderer/components/wizard/Step5MachineIdentity';
import { Step6Behavior } from '../../src/renderer/components/wizard/Step6Behavior';
import { Step7ReviewAndDryRun } from '../../src/renderer/components/wizard/Step7ReviewAndDryRun';
import {
  DEFAULT_EXCLUDE_GLOBS,
  PREFS_INIT_TXT_GLOB,
  isValidMachineId,
  type Step4Payload,
  type Step5Payload,
  type Step6Payload,
  type WizardDraft
} from '../../src/renderer/state/store';

/**
 * Renderer tests for Phase 8 — wizard steps 4-7 + Finish commit.
 *
 * These exercise the user-visible behavior, mock `window.df` with vi.fn,
 * and assert via standard `expect` (no jest-dom).
 */

type DfMock = {
  config: {
    get: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    isFirstRun: ReturnType<typeof vi.fn>;
  };
  paths: {
    detectGameFolder: ReturnType<typeof vi.fn>;
    validateCloudFolder: ReturnType<typeof vi.fn>;
    pickFolder: ReturnType<typeof vi.fn>;
    estimateSize: ReturnType<typeof vi.fn>;
  };
  sync: {
    planDryRun: ReturnType<typeof vi.fn>;
  };
  app: {
    hostname: ReturnType<typeof vi.fn>;
    setStartWithWindows: ReturnType<typeof vi.fn>;
  };
};

function installDfMock(
  overrides: Partial<{
    paths: Partial<DfMock['paths']>;
    config: Partial<DfMock['config']>;
    sync: Partial<DfMock['sync']>;
    app: Partial<DfMock['app']>;
  }> = {}
): DfMock {
  const mock: DfMock = {
    config: {
      get: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      save: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      isFirstRun: vi.fn().mockResolvedValue({ ok: true, data: true }),
      ...overrides.config
    },
    paths: {
      detectGameFolder: vi.fn().mockResolvedValue({ ok: true, data: null }),
      validateCloudFolder: vi.fn().mockResolvedValue({
        ok: true,
        data: { ok: true, freeBytes: 18 * 1024 * 1024 * 1024 }
      }),
      pickFolder: vi.fn().mockResolvedValue({ ok: true, data: null }),
      estimateSize: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { bytes: 0, fileCount: 0 } }),
      ...overrides.paths
    },
    sync: {
      planDryRun: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          plan: {
            id: 'p',
            createdAt: '2026-05-07T00:00:00Z',
            direction: 'full',
            items: [],
            summary: { pushCount: 0, pullCount: 0, conflictCount: 0, totalBytes: 0 }
          }
        }
      }),
      ...overrides.sync
    },
    app: {
      hostname: vi.fn().mockResolvedValue({ ok: true, data: 'TEST-PC' }),
      setStartWithWindows: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      ...overrides.app
    }
  };
  Object.defineProperty(window, 'df', {
    value: mock,
    writable: true,
    configurable: true
  });
  return mock;
}

describe('isValidMachineId', () => {
  it('accepts valid identifiers', () => {
    expect(isValidMachineId('PC-A')).toBe(true);
    expect(isValidMachineId('home_desktop.01')).toBe(true);
    expect(isValidMachineId('a')).toBe(true);
    expect(isValidMachineId('a'.repeat(32))).toBe(true);
  });

  it('rejects empty, oversized, and invalid characters', () => {
    expect(isValidMachineId('')).toBe(false);
    expect(isValidMachineId(undefined)).toBe(false);
    expect(isValidMachineId('a'.repeat(33))).toBe(false);
    expect(isValidMachineId('has space')).toBe(false);
    expect(isValidMachineId('has/slash')).toBe(false);
    expect(isValidMachineId('hi@there')).toBe(false);
  });
});

/* ───────────────── Step 4 ───────────────── */

describe('Step4SyncSelection', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders defaults from §5.1: save/mods/prefs ON, data OFF', async () => {
    installDfMock({
      paths: {
        estimateSize: vi.fn().mockResolvedValue({
          ok: true,
          data: { bytes: 1024 * 1024, fileCount: 5 }
        })
      }
    });

    let payload: Step4Payload | null = null;
    render(
      <Step4SyncSelection
        gameFolder="C:/Users/x/AppData/Roaming/Bay 12 Games/Dwarf Fortress"
        enabledFolders={undefined}
        excludeGlobs={undefined}
        onChange={(p) => {
          payload = p;
        }}
      />
    );

    // The component fires an initial onChange seeding defaults.
    await waitFor(() => {
      expect(payload).not.toBeNull();
    });
    expect(payload!.enabledFolders).toEqual({
      data: false,
      mods: true,
      prefs: true,
      save: true
    });
    // Default excludes + the prefs/init.txt rule (since prefs is on by default).
    expect(payload!.excludeGlobs).toContain(PREFS_INIT_TXT_GLOB);
    for (const g of DEFAULT_EXCLUDE_GLOBS) {
      expect(payload!.excludeGlobs).toContain(g);
    }

    // Each folder gets a size estimate row.
    await waitFor(() => {
      expect((screen.getByTestId('step4-size-save') as HTMLElement).textContent).toMatch(
        /1\.0 MB/
      );
    });
  });

  it('toggling prefs/init.txt mutates excludeGlobs', async () => {
    installDfMock();
    const initialDraft: WizardDraft = {
      enabledFolders: { data: false, mods: true, prefs: true, save: true },
      excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS, PREFS_INIT_TXT_GLOB]
    };
    let lastPayload: Step4Payload = {
      enabledFolders: initialDraft.enabledFolders!,
      excludeGlobs: initialDraft.excludeGlobs!
    };

    const { rerender } = render(
      <Step4SyncSelection
        gameFolder=""
        enabledFolders={initialDraft.enabledFolders}
        excludeGlobs={initialDraft.excludeGlobs}
        onChange={(p) => {
          lastPayload = p;
        }}
      />
    );

    const user = userEvent.setup();
    const toggle = screen.getByTestId('step4-init-txt-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(lastPayload.excludeGlobs).toContain(PREFS_INIT_TXT_GLOB);

    await user.click(toggle);
    expect(lastPayload.excludeGlobs).not.toContain(PREFS_INIT_TXT_GLOB);

    // Re-render with the new value.
    rerender(
      <Step4SyncSelection
        gameFolder=""
        enabledFolders={lastPayload.enabledFolders}
        excludeGlobs={lastPayload.excludeGlobs}
        onChange={(p) => {
          lastPayload = p;
        }}
      />
    );

    const toggle2 = screen.getByTestId('step4-init-txt-toggle') as HTMLInputElement;
    expect(toggle2.checked).toBe(false);
    await user.click(toggle2);
    expect(lastPayload.excludeGlobs).toContain(PREFS_INIT_TXT_GLOB);
  });

  it('hides prefs/init.txt toggle when prefs is off and removes the glob', async () => {
    installDfMock();
    const initialEnabled = { data: false, mods: true, prefs: true, save: true };
    const initialExcludes = [...DEFAULT_EXCLUDE_GLOBS, PREFS_INIT_TXT_GLOB];
    let payload: Step4Payload = {
      enabledFolders: initialEnabled,
      excludeGlobs: initialExcludes
    };

    const { rerender } = render(
      <Step4SyncSelection
        gameFolder=""
        enabledFolders={initialEnabled}
        excludeGlobs={initialExcludes}
        onChange={(p) => {
          payload = p;
        }}
      />
    );

    const user = userEvent.setup();
    expect(screen.queryByTestId('step4-init-txt-toggle')).not.toBeNull();
    await user.click(screen.getByTestId('step4-folder-prefs'));

    expect(payload.enabledFolders.prefs).toBe(false);
    expect(payload.excludeGlobs).not.toContain(PREFS_INIT_TXT_GLOB);

    rerender(
      <Step4SyncSelection
        gameFolder=""
        enabledFolders={payload.enabledFolders}
        excludeGlobs={payload.excludeGlobs}
        onChange={(p) => {
          payload = p;
        }}
      />
    );
    expect(screen.queryByTestId('step4-init-txt-toggle')).toBeNull();
  });

  it('shows the no-folders error when the user disables everything', async () => {
    installDfMock();
    const initialEnabled = { data: false, mods: false, prefs: false, save: true };
    let payload: Step4Payload = {
      enabledFolders: initialEnabled,
      excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS]
    };
    const { rerender } = render(
      <Step4SyncSelection
        gameFolder=""
        enabledFolders={initialEnabled}
        excludeGlobs={[...DEFAULT_EXCLUDE_GLOBS]}
        onChange={(p) => {
          payload = p;
        }}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId('step4-folder-save'));
    rerender(
      <Step4SyncSelection
        gameFolder=""
        enabledFolders={payload.enabledFolders}
        excludeGlobs={payload.excludeGlobs}
        onChange={(p) => {
          payload = p;
        }}
      />
    );
    expect(screen.queryByTestId('step4-no-folders')).not.toBeNull();
  });
});

/* ───────────────── Step 5 ───────────────── */

describe('Step5MachineIdentity', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('auto-fills from os.hostname()', async () => {
    installDfMock({
      app: { hostname: vi.fn().mockResolvedValue({ ok: true, data: 'BIGBOSS' }) }
    });

    let payload: Step5Payload | null = null;
    render(
      <Step5MachineIdentity
        machineId={undefined}
        onChange={(p) => {
          payload = p;
        }}
      />
    );

    await waitFor(() => {
      expect(payload).not.toBeNull();
      expect(payload!.machineId).toBe('BIGBOSS');
    });
  });

  it('sanitizes hostnames with invalid characters', async () => {
    installDfMock({
      app: {
        hostname: vi.fn().mockResolvedValue({ ok: true, data: 'name with space@home' })
      }
    });
    let payload: Step5Payload | null = null;
    render(
      <Step5MachineIdentity
        machineId={undefined}
        onChange={(p) => {
          payload = p;
        }}
      />
    );
    await waitFor(() => {
      expect(payload).not.toBeNull();
    });
    // Spaces and @ both replaced with `-`.
    expect(payload!.machineId).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('shows validation errors for invalid input', async () => {
    installDfMock();
    const Wrapped = (): JSX.Element => {
      const [id, setId] = useState<string>('PC-A');
      return (
        <Step5MachineIdentity
          machineId={id}
          onChange={(p) => {
            setId(p.machineId);
          }}
        />
      );
    };
    render(<Wrapped />);
    const user = userEvent.setup();
    const input = screen.getByTestId('step5-machine-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'has space');
    await waitFor(() => {
      expect(screen.queryByTestId('step5-validation')).not.toBeNull();
    });
    expect((screen.getByTestId('step5-validation') as HTMLElement).textContent).toMatch(
      /letters, numbers/i
    );
  });
});

/* ───────────────── Step 6 ───────────────── */

describe('Step6Behavior', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('seeds defaults matching §5.1 on first mount', async () => {
    installDfMock();
    let payload: Step6Payload | null = null;
    render(
      <Step6Behavior
        conflictPolicy={undefined}
        backup={undefined}
        monitor={undefined}
        startWithWindows={undefined}
        startMinimizedToTray={undefined}
        onChange={(p) => {
          payload = p;
        }}
      />
    );

    await waitFor(() => {
      expect(payload).not.toBeNull();
    });
    expect(payload!.conflictPolicy).toBe('newer-wins-backup');
    expect(payload!.backup).toEqual({ keepLastN: 10, compress: true });
    expect(payload!.monitor).toEqual({
      enabled: true,
      onGameStart: 'prompt-pull',
      onGameExit: 'prompt-push',
      pollIntervalMs: 3000
    });
    expect(payload!.startWithWindows).toBe(false);
    expect(payload!.startMinimizedToTray).toBe(false);
  });

  it('changing the slider updates backup.keepLastN', async () => {
    installDfMock();
    let captured: Step6Payload | null = null;
    const Wrapped = (): JSX.Element => {
      const [payload, setPayload] = useState<Step6Payload>({
        conflictPolicy: 'newer-wins-backup',
        backup: { keepLastN: 10, compress: true },
        monitor: {
          enabled: true,
          onGameStart: 'prompt-pull',
          onGameExit: 'prompt-push',
          pollIntervalMs: 3000
        },
        startWithWindows: false,
        startMinimizedToTray: false
      });
      captured = payload;
      return (
        <Step6Behavior
          conflictPolicy={payload.conflictPolicy}
          backup={payload.backup}
          monitor={payload.monitor}
          startWithWindows={payload.startWithWindows}
          startMinimizedToTray={payload.startMinimizedToTray}
          onChange={(p) => {
            setPayload(p);
          }}
        />
      );
    };
    render(<Wrapped />);
    const slider = screen.getByTestId('step6-keep-slider') as HTMLInputElement;
    // userEvent on type=range is fiddly; use RTL's fireEvent.change so
    // React's synthetic event system picks it up.
    fireEvent.change(slider, { target: { value: '5' } });
    await waitFor(() => {
      expect(captured?.backup.keepLastN).toBe(5);
    });
  });

  it('disables Start-minimized when Start-with-Windows is off', async () => {
    installDfMock();
    let payload: Step6Payload = {
      conflictPolicy: 'newer-wins-backup',
      backup: { keepLastN: 10, compress: true },
      monitor: {
        enabled: true,
        onGameStart: 'prompt-pull',
        onGameExit: 'prompt-push',
        pollIntervalMs: 3000
      },
      startWithWindows: false,
      startMinimizedToTray: false
    };
    render(
      <Step6Behavior
        conflictPolicy={payload.conflictPolicy}
        backup={payload.backup}
        monitor={payload.monitor}
        startWithWindows={payload.startWithWindows}
        startMinimizedToTray={payload.startMinimizedToTray}
        onChange={(p) => {
          payload = p;
        }}
      />
    );
    const minimized = screen.getByTestId('step6-start-minimized') as HTMLInputElement;
    expect(minimized.disabled).toBe(true);
  });
});

/* ───────────────── Step 7 ───────────────── */

describe('Step7ReviewAndDryRun', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a read-only summary of the draft', () => {
    installDfMock();
    const draft: WizardDraft = {
      cloudFolder: 'C:/Cloud',
      gameFolder: 'C:/DF',
      enabledFolders: { data: false, mods: true, prefs: true, save: true },
      excludeGlobs: [PREFS_INIT_TXT_GLOB],
      machineId: 'PC-A',
      conflictPolicy: 'newer-wins-backup',
      backup: { keepLastN: 10, compress: true },
      monitor: {
        enabled: true,
        onGameStart: 'prompt-pull',
        onGameExit: 'prompt-push',
        pollIntervalMs: 3000
      },
      startWithWindows: false,
      startMinimizedToTray: false
    };

    render(<Step7ReviewAndDryRun draft={draft} />);

    const summary = screen.getByTestId('step7-summary');
    expect(summary.textContent).toMatch(/C:\/Cloud/);
    expect(summary.textContent).toMatch(/C:\/DF/);
    expect(summary.textContent).toMatch(/PC-A/);
    expect(summary.textContent).toMatch(/newer-wins-backup/);
    expect(summary.textContent).toMatch(/keep last 10/);
  });

  it('runs dry-run and renders summary counts', async () => {
    const planDryRun = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        plan: {
          id: 'p',
          createdAt: '2026-05-07T00:00:00Z',
          direction: 'full',
          items: [
            {
              rel: 'save/Region1/world.sav',
              kind: 'push',
              applied: true,
              bytes: 2_400_000,
              localEntry: null,
              cloudEntry: null,
              baseEntry: null
            }
          ],
          summary: { pushCount: 1, pullCount: 0, conflictCount: 0, totalBytes: 2_400_000 }
        }
      }
    });
    installDfMock({ sync: { planDryRun } });

    const draft: WizardDraft = { cloudFolder: 'C:/Cloud', gameFolder: 'C:/DF' };
    const user = userEvent.setup();
    render(<Step7ReviewAndDryRun draft={draft} />);

    await user.click(screen.getByTestId('step7-dryrun-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('step7-dryrun-result')).not.toBeNull();
    });
    expect(planDryRun).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('step7-summary-push') as HTMLElement).textContent).toMatch(/1/);
    expect((screen.getByTestId('step7-summary-bytes') as HTMLElement).textContent).toMatch(
      /2\.3 MB/
    );
  });

  it('surfaces the stub note prominently when the engine returns one', async () => {
    const planDryRun = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        plan: {
          id: 'stub',
          createdAt: '2026-05-07T00:00:00Z',
          direction: 'full',
          items: [],
          summary: { pushCount: 0, pullCount: 0, conflictCount: 0, totalBytes: 0 }
        },
        notes: 'Diff engine lands in Phase 4 — preview will be live once both phases land.'
      }
    });
    installDfMock({ sync: { planDryRun } });

    const user = userEvent.setup();
    render(<Step7ReviewAndDryRun draft={{}} />);
    await user.click(screen.getByTestId('step7-dryrun-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('step7-dryrun-note')).not.toBeNull();
    });
    expect((screen.getByTestId('step7-dryrun-note') as HTMLElement).textContent).toMatch(
      /Phase 4/
    );
  });
});

/* ───────────────── Wizard Shell — Finish ───────────────── */

describe('WizardShell — Finish commit', () => {
  beforeEach(() => {
    // jsdom's userAgent triggers `setLoginItemSettings` paths in some
    // electron stubs; nothing else to set up here.
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * Drive the wizard through every step using the public UI. Returns
   * the captured `df` mock so the test can inspect call arguments.
   */
  async function navigateToFinish(): Promise<DfMock> {
    const mock = installDfMock({
      paths: {
        detectGameFolder: vi
          .fn()
          .mockResolvedValue({ ok: true, data: 'C:/DF' }),
        pickFolder: vi.fn().mockResolvedValue({ ok: true, data: 'C:/Cloud' }),
        validateCloudFolder: vi.fn().mockResolvedValue({
          ok: true,
          data: { ok: true, freeBytes: 21474836480 }
        }),
        estimateSize: vi
          .fn()
          .mockResolvedValue({ ok: true, data: { bytes: 0, fileCount: 0 } })
      },
      app: {
        hostname: vi.fn().mockResolvedValue({ ok: true, data: 'PC-A' }),
        setStartWithWindows: vi
          .fn()
          .mockResolvedValue({ ok: true, data: undefined })
      }
    });
    const onExit = vi.fn();
    const user = userEvent.setup();
    render(<WizardShell onExit={onExit} />);

    // Step 1 → 2.
    await user.click(screen.getByTestId('wizard-next'));

    // Step 2: pick a cloud folder and wait for validation.
    await user.click(screen.getByRole('button', { name: /browse/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('step2-ok')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));

    // Step 3: detection auto-fills, badge appears.
    await waitFor(() => {
      expect(screen.queryByTestId('step3-detected-badge')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));

    // Step 4: defaults render. We allow next.
    await waitFor(() => {
      expect(screen.queryByTestId('step4-folder-save')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));

    // Step 5: hostname auto-fills.
    await waitFor(() => {
      const input = screen.getByTestId('step5-machine-input') as HTMLInputElement;
      expect(input.value).toBe('PC-A');
    });
    await user.click(screen.getByTestId('wizard-next'));

    // Step 6: defaults seed.
    await waitFor(() => {
      expect(screen.queryByTestId('step6-keep-slider')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));

    // Step 7: Finish.
    await waitFor(() => {
      expect(screen.queryByTestId('step7-summary')).not.toBeNull();
    });

    // Click Finish.
    await user.click(screen.getByTestId('wizard-next'));

    await waitFor(() => {
      expect(onExit).toHaveBeenCalled();
    });

    // Attach onExit to the mock for assertions.
    (mock as DfMock & { onExit: typeof onExit }).onExit = onExit;
    return mock;
  }

  it('persists the draft with firstRunCompleted: true and routes out', async () => {
    const mock = await navigateToFinish();

    expect(mock.config.save).toHaveBeenCalledTimes(1);
    const savedPatch = mock.config.save.mock.calls[0][0];
    expect(savedPatch.firstRunCompleted).toBe(true);
    expect(savedPatch.cloudFolder).toBe('C:/Cloud');
    expect(savedPatch.gameFolder).toBe('C:/DF');
    expect(savedPatch.machineId).toBe('PC-A');
    expect(savedPatch.conflictPolicy).toBe('newer-wins-backup');

    // setStartWithWindows was called once.
    expect(mock.app.setStartWithWindows).toHaveBeenCalledTimes(1);
    expect(mock.app.setStartWithWindows.mock.calls[0][0]).toEqual({
      openAtLogin: false,
      openAsHidden: false
    });
  });

  it('shows an error and does not route when save fails', async () => {
    installDfMock({
      paths: {
        detectGameFolder: vi.fn().mockResolvedValue({ ok: true, data: 'C:/DF' }),
        pickFolder: vi.fn().mockResolvedValue({ ok: true, data: 'C:/Cloud' }),
        validateCloudFolder: vi
          .fn()
          .mockResolvedValue({ ok: true, data: { ok: true, freeBytes: 1024 ** 3 } }),
        estimateSize: vi
          .fn()
          .mockResolvedValue({ ok: true, data: { bytes: 0, fileCount: 0 } })
      },
      config: {
        get: vi.fn().mockResolvedValue({ ok: true, data: {} }),
        save: vi.fn().mockResolvedValue({ ok: false, error: 'disk full' }),
        isFirstRun: vi.fn().mockResolvedValue({ ok: true, data: true })
      },
      app: {
        hostname: vi.fn().mockResolvedValue({ ok: true, data: 'PC-A' }),
        setStartWithWindows: vi
          .fn()
          .mockResolvedValue({ ok: true, data: undefined })
      }
    });
    const onExit = vi.fn();
    const user = userEvent.setup();
    render(<WizardShell onExit={onExit} />);

    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByRole('button', { name: /browse/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('step2-ok')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      expect(screen.queryByTestId('step3-detected-badge')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      expect(screen.queryByTestId('step4-folder-save')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      const input = screen.getByTestId('step5-machine-input') as HTMLInputElement;
      expect(input.value).toBe('PC-A');
    });
    await user.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      expect(screen.queryByTestId('step6-keep-slider')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      expect(screen.queryByTestId('step7-summary')).not.toBeNull();
    });
    await user.click(screen.getByTestId('wizard-next'));

    await waitFor(() => {
      expect(screen.queryByTestId('wizard-finish-error')).not.toBeNull();
    });
    expect(onExit).not.toHaveBeenCalled();
  });
});
