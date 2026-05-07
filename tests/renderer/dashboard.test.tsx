import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AppConfig,
  SyncHistoryEntry,
  SyncPlan,
  SyncPlanResult,
  SyncProgress,
  SyncResult
} from '../../src/shared/types';
import { Dashboard } from '../../src/renderer/components/main/Dashboard';
import { DiffTable } from '../../src/renderer/components/main/DiffTable';

/**
 * Renderer tests for Phase 9 — dashboard.
 *
 * Mocks `window.df` directly with vitest fn()s. Each scenario installs
 * its own bridge via `installDfMock(...)`. Assertions use plain
 * `expect` (no jest-dom).
 */

type ProgressCb = (p: SyncProgress) => void;

type DashboardMock = {
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
    probeExistingManifest: ReturnType<typeof vi.fn>;
  };
  sync: {
    plan: ReturnType<typeof vi.fn>;
    planDryRun: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    onProgress: ReturnType<typeof vi.fn>;
  };
  history: {
    list: ReturnType<typeof vi.fn>;
    openBackupFolder: ReturnType<typeof vi.fn>;
  };
  app: {
    hostname: ReturnType<typeof vi.fn>;
    setStartWithWindows: ReturnType<typeof vi.fn>;
  };
};

type Overrides = Partial<{
  config: Partial<DashboardMock['config']>;
  paths: Partial<DashboardMock['paths']>;
  sync: Partial<DashboardMock['sync']>;
  history: Partial<DashboardMock['history']>;
  app: Partial<DashboardMock['app']>;
  /** Hook to capture the progress callback registered by the dashboard. */
  onProgressCapture?: { current: ProgressCb | null };
}>;

const SAMPLE_CONFIG: AppConfig = {
  schemaVersion: 1,
  cloudFolder: 'C:\\Users\\me\\OneDrive\\df-mirror',
  gameFolder: 'C:\\Users\\me\\AppData\\Roaming\\Bay 12 Games\\Dwarf Fortress',
  enabledFolders: { data: false, mods: true, prefs: true, save: true },
  excludeGlobs: [],
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
  firstRunCompleted: true
};

function installDfMock(overrides: Overrides = {}): DashboardMock {
  const onProgressCapture = overrides.onProgressCapture;
  const mock: DashboardMock = {
    config: {
      get: vi.fn().mockResolvedValue({ ok: true, data: SAMPLE_CONFIG }),
      save: vi.fn().mockResolvedValue({ ok: true, data: SAMPLE_CONFIG }),
      isFirstRun: vi.fn().mockResolvedValue({ ok: true, data: false }),
      ...overrides.config
    },
    paths: {
      detectGameFolder: vi.fn().mockResolvedValue({ ok: true, data: null }),
      validateCloudFolder: vi.fn().mockResolvedValue({
        ok: true,
        data: { ok: true, freeBytes: 18 * 1024 * 1024 * 1024 }
      }),
      pickFolder: vi.fn().mockResolvedValue({ ok: true, data: null }),
      estimateSize: vi.fn().mockResolvedValue({ ok: true, data: { bytes: 0, fileCount: 0 } }),
      probeExistingManifest: vi.fn().mockResolvedValue({ ok: true, data: null }),
      ...overrides.paths
    },
    sync: {
      plan: vi.fn().mockResolvedValue({
        ok: true,
        data: makePlanResult([])
      }),
      planDryRun: vi.fn().mockResolvedValue({
        ok: true,
        data: { plan: makeEmptyPlan('full') }
      }),
      apply: vi.fn().mockResolvedValue({
        ok: true,
        data: makeOkApplyResult(0)
      }),
      getStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: { inProgress: false }
      }),
      cancel: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      onProgress: vi.fn((cb: ProgressCb) => {
        if (onProgressCapture) onProgressCapture.current = cb;
        return () => {
          if (onProgressCapture) onProgressCapture.current = null;
        };
      }),
      ...overrides.sync
    },
    history: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      openBackupFolder: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      ...overrides.history
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

function makeEmptyPlan(direction: 'push' | 'pull' | 'full'): SyncPlan {
  return {
    id: 'plan-1',
    createdAt: '2026-05-07T10:00:00.000Z',
    direction,
    items: [],
    summary: { pushCount: 0, pullCount: 0, conflictCount: 0, totalBytes: 0 }
  };
}

function makePlanResult(
  items: SyncPlan['items'],
  opts: {
    direction?: 'push' | 'pull' | 'full';
    prompts?: SyncPlanResult['prompts'];
  } = {}
): SyncPlanResult {
  const direction = opts.direction ?? 'full';
  const summary = {
    pushCount: items.filter((i) => i.kind === 'push' || i.kind === 'push-delete').length,
    pullCount: items.filter((i) => i.kind === 'pull' || i.kind === 'pull-delete').length,
    conflictCount: items.filter((i) => i.kind.startsWith('conflict-')).length,
    totalBytes: items.reduce((acc, i) => acc + (i.applied ? i.bytes : 0), 0)
  };
  return {
    plan: {
      id: 'plan-1',
      createdAt: '2026-05-07T10:00:00.000Z',
      direction,
      items,
      summary
    },
    prompts: opts.prompts ?? []
  };
}

function makeOkApplyResult(applied: number, bytesWritten = 0): SyncResult {
  return {
    planId: 'plan-1',
    startedAt: '2026-05-07T10:00:00.000Z',
    completedAt: '2026-05-07T10:00:01.000Z',
    direction: 'push',
    dryRun: false,
    ok: true,
    applied,
    skipped: 0,
    conflicts: [],
    bytesWritten,
    backupCount: 0
  };
}

function makeFailApplyResult(errorKind: SyncResult['errorKind'], message: string): SyncResult {
  return {
    planId: 'plan-1',
    startedAt: '2026-05-07T10:00:00.000Z',
    completedAt: '2026-05-07T10:00:01.000Z',
    direction: 'push',
    dryRun: false,
    ok: false,
    applied: 0,
    skipped: 0,
    conflicts: [],
    bytesWritten: 0,
    backupCount: 0,
    errorKind,
    error: message
  };
}

const PUSH_ITEM = {
  rel: 'save/region1/world.sav',
  kind: 'push' as const,
  applied: true,
  bytes: 2_400_000,
  localEntry: { rel: 'save/region1/world.sav', size: 2_400_000, mtimeMs: 1, sha1: 'abcdef0011' },
  cloudEntry: null,
  baseEntry: null
};

const CONFLICT_ITEM = {
  rel: 'prefs/announcements.txt',
  kind: 'conflict-newer-local' as const,
  applied: true,
  bytes: 1024,
  localEntry: { rel: 'prefs/announcements.txt', size: 1024, mtimeMs: 2, sha1: 'aa11' },
  cloudEntry: { rel: 'prefs/announcements.txt', size: 1000, mtimeMs: 1, sha1: 'bb22' },
  baseEntry: null
};

/* ───────────────── Tests ───────────────── */

describe('Dashboard — empty state', () => {
  beforeEach(() => {
    installDfMock();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the four sync buttons and an empty-state message', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).not.toBeNull();
    });
    expect(screen.getByTestId('sync-btn-pull')).not.toBeNull();
    expect(screen.getByTestId('sync-btn-push')).not.toBeNull();
    expect(screen.getByTestId('sync-btn-full')).not.toBeNull();
    expect(screen.getByTestId('sync-btn-dryrun')).not.toBeNull();
    expect(screen.getByTestId('sync-controls-empty').textContent).toMatch(/no plan yet/i);
    expect(screen.queryByTestId('diff-table')).toBeNull();
  });

  it('shows "never" for last-sync when history is empty', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-last-sync').textContent).toContain('never');
    });
  });
});

describe('Dashboard — push plan + apply', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('clicking Push loads a plan and renders DiffTable', async () => {
    const mock = installDfMock({
      sync: {
        plan: vi.fn().mockResolvedValue({
          ok: true,
          data: makePlanResult([PUSH_ITEM], { direction: 'push' })
        })
      }
    });
    render(<Dashboard />);
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('sync-btn-push')).not.toBeNull();
    });
    await user.click(screen.getByTestId('sync-btn-push'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-table')).not.toBeNull();
    });
    expect(mock.sync.plan).toHaveBeenCalledWith({ direction: 'push', dryRun: false });
    expect(screen.getByTestId('diff-summary-push').textContent).toContain('1');
    expect(screen.getByTestId('diff-table-apply')).not.toBeNull();
  });

  it('clicking Apply runs the sync and shows a success toast', async () => {
    const mock = installDfMock({
      sync: {
        plan: vi.fn().mockResolvedValue({
          ok: true,
          data: makePlanResult([PUSH_ITEM], { direction: 'push' })
        }),
        apply: vi.fn().mockResolvedValue({
          ok: true,
          data: makeOkApplyResult(1, 2_400_000)
        })
      }
    });
    render(<Dashboard />);
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('sync-btn-push')).not.toBeNull();
    });
    await user.click(screen.getByTestId('sync-btn-push'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-table-apply')).not.toBeNull();
    });
    await user.click(screen.getByTestId('diff-table-apply'));
    await waitFor(() => {
      expect(mock.sync.apply).toHaveBeenCalled();
    });
    await waitFor(() => {
      const toast = screen.getByTestId('toast-success');
      expect(toast.textContent).toMatch(/sync completed/i);
      expect(toast.textContent).toMatch(/1 file/);
    });
    // Plan cleared after success.
    await waitFor(() => {
      expect(screen.queryByTestId('diff-table')).toBeNull();
    });
  });

  it('apply failure renders an error toast and keeps the plan', async () => {
    installDfMock({
      sync: {
        plan: vi.fn().mockResolvedValue({
          ok: true,
          data: makePlanResult([PUSH_ITEM], { direction: 'push' })
        }),
        apply: vi.fn().mockResolvedValue({
          ok: true,
          data: makeFailApplyResult('insufficient-cloud-space', 'free space too low')
        })
      }
    });
    render(<Dashboard />);
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('sync-btn-push')).not.toBeNull();
    });
    await user.click(screen.getByTestId('sync-btn-push'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-table-apply')).not.toBeNull();
    });
    await user.click(screen.getByTestId('diff-table-apply'));
    await waitFor(() => {
      const toast = screen.getByTestId('toast-error');
      expect(toast.textContent).toMatch(/sync failed/i);
    });
    // Plan still visible so user can retry.
    expect(screen.getByTestId('diff-table')).not.toBeNull();
  });
});

describe('Dashboard — conflicts', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the conflict dialog when prompts are returned', async () => {
    installDfMock({
      sync: {
        plan: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            ...makePlanResult([CONFLICT_ITEM], { direction: 'full' }),
            prompts: [
              {
                rel: 'prefs/announcements.txt',
                kind: 'conflict-newer-local',
                options: ['keep-local', 'keep-cloud', 'keep-both']
              }
            ]
          }
        })
      }
    });
    render(<Dashboard />);
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('sync-btn-full')).not.toBeNull();
    });
    await user.click(screen.getByTestId('sync-btn-full'));
    await waitFor(() => {
      expect(screen.getByTestId('conflict-dialog')).not.toBeNull();
    });
    const row = screen.getByTestId('conflict-dialog-row');
    expect(row.getAttribute('data-rel')).toBe('prefs/announcements.txt');
    // 3 options with keep-both disabled.
    const radios = within(row).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.length).toBe(3);
    const keepBoth = radios.find((r) => r.value === 'keep-both');
    expect(keepBoth?.disabled).toBe(true);

    // Choose keep-cloud and resolve.
    const keepCloud = radios.find((r) => r.value === 'keep-cloud') as HTMLInputElement;
    await user.click(keepCloud);
    await user.click(screen.getByTestId('conflict-dialog-resolve'));

    // Conflict dialog gone; DiffTable visible with the rewritten plan.
    await waitFor(() => {
      expect(screen.queryByTestId('conflict-dialog')).toBeNull();
      expect(screen.getByTestId('diff-table')).not.toBeNull();
    });
    // The previously-conflict item is now a pull row.
    const rows = screen.getAllByTestId('diff-table-row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute('data-kind')).toBe('pull');
    // Apply is enabled now (no unresolved conflicts).
    expect(screen.getByTestId('diff-table-apply')).not.toBeNull();
  });
});

describe('Dashboard — history', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('populates HistoryPanel from api.history.list()', async () => {
    const sampleEntry: SyncHistoryEntry = {
      timestamp: '2026-05-07T09-00-00-000Z',
      direction: 'push',
      result: {
        ...makeOkApplyResult(4, 2_400_000),
        backupTimestamp: '2026-05-07T09-00-00-000Z'
      }
    };
    const mock = installDfMock({
      history: {
        list: vi.fn().mockResolvedValue({ ok: true, data: [sampleEntry] })
      }
    });
    render(<Dashboard />);
    const user = userEvent.setup();
    await waitFor(() => {
      const rows = screen.getAllByTestId('history-panel-row');
      expect(rows.length).toBe(1);
    });
    const row = screen.getAllByTestId('history-panel-row')[0]!;
    expect(row.textContent).toMatch(/push/i);
    expect(row.textContent).toMatch(/4 files/);

    // Click Open Backup → IPC called with the right timestamp.
    await user.click(within(row).getByTestId('history-panel-open-backup'));
    await waitFor(() => {
      expect(mock.history.openBackupFolder).toHaveBeenCalledWith(sampleEntry.timestamp);
    });
  });

  it('shows the last-sync line in the header from history', async () => {
    const recentEntry: SyncHistoryEntry = {
      timestamp: '2026-05-07T09-00-00-000Z',
      direction: 'push',
      result: {
        ...makeOkApplyResult(4, 2_400_000),
        completedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
      }
    };
    installDfMock({
      history: {
        list: vi.fn().mockResolvedValue({ ok: true, data: [recentEntry] })
      }
    });
    render(<Dashboard />);
    await waitFor(() => {
      const lastSync = screen.getByTestId('dashboard-last-sync');
      expect(lastSync.textContent).toMatch(/min ago/i);
      expect(lastSync.textContent).toMatch(/push/);
    });
  });
});

describe('DiffTable — dry-run mode', () => {
  afterEach(() => {
    cleanup();
  });

  it('never offers the Apply button in dryrun mode', () => {
    render(
      <DiffTable
        plan={makePlanResult([PUSH_ITEM], { direction: 'full' }).plan}
        mode="dryrun"
      />
    );
    expect(screen.queryByTestId('diff-table-apply')).toBeNull();
    expect(screen.getByTestId('diff-table-dryrun-note')).not.toBeNull();
  });
});

describe('DiffTable — conflict pinning + filter', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders conflicts before pushes regardless of input order', () => {
    const planResult = makePlanResult(
      [PUSH_ITEM, CONFLICT_ITEM, { ...PUSH_ITEM, rel: 'save/region1/extra.dat' }],
      { direction: 'full' }
    );
    render(<DiffTable plan={planResult.plan} mode="preview" />);
    const rows = screen.getAllByTestId('diff-table-row');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // First row should be the conflict.
    expect(rows[0]?.getAttribute('data-kind')).toBe('conflict-newer-local');
  });

  it('filtering to "Conflicts" hides non-conflict rows', async () => {
    const planResult = makePlanResult([PUSH_ITEM, CONFLICT_ITEM], { direction: 'full' });
    render(<DiffTable plan={planResult.plan} mode="preview" />);
    const user = userEvent.setup();
    const select = screen.getByTestId('diff-table-filter') as HTMLSelectElement;
    await user.selectOptions(select, 'conflicts');
    const rows = screen.getAllByTestId('diff-table-row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute('data-kind')).toBe('conflict-newer-local');
  });
});

describe('DiffTable — in-progress', () => {
  afterEach(() => {
    cleanup();
  });

  it('disables Apply and shows progress while in-progress', () => {
    const planResult = makePlanResult([PUSH_ITEM], { direction: 'push' });
    const progress: SyncProgress = {
      phase: 'apply',
      index: 1,
      total: 4,
      currentRel: 'save/region1/world.sav'
    };
    render(
      <DiffTable
        plan={planResult.plan}
        mode="preview"
        inProgress
        progress={progress}
        onApply={() => {}}
        onAbort={() => {}}
      />
    );
    // Apply is hidden while in-progress; only the abort button is shown.
    expect(screen.queryByTestId('diff-table-apply')).toBeNull();
    expect(screen.getByTestId('diff-table-abort')).not.toBeNull();
    // Progress bar present.
    expect(screen.getByTestId('diff-table-progress')).not.toBeNull();
  });
});

describe('SyncControls — progress events update DiffTable', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('queued progress events flow into the in-progress view', async () => {
    const captured: { current: ProgressCb | null } = { current: null };
    let resolveApply!: (val: { ok: true; data: SyncResult }) => void;
    installDfMock({
      sync: {
        plan: vi.fn().mockResolvedValue({
          ok: true,
          data: makePlanResult([PUSH_ITEM], { direction: 'push' })
        }),
        apply: vi.fn(
          () =>
            new Promise<{ ok: true; data: SyncResult }>((resolve) => {
              resolveApply = resolve;
            })
        )
      },
      onProgressCapture: captured
    });
    render(<Dashboard />);
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('sync-btn-push')).not.toBeNull();
    });
    await user.click(screen.getByTestId('sync-btn-push'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-table-apply')).not.toBeNull();
    });
    await user.click(screen.getByTestId('diff-table-apply'));

    // The component subscribed; emit a progress event.
    await waitFor(() => {
      expect(captured.current).not.toBeNull();
    });
    act(() => {
      captured.current!({
        phase: 'apply',
        index: 1,
        total: 1,
        currentRel: 'save/region1/world.sav'
      });
    });
    // Wait for the throttled flush.
    await waitFor(
      () => {
        expect(screen.getByTestId('diff-table-progress')).not.toBeNull();
      },
      { timeout: 500 }
    );

    // Resolve the apply promise so the test cleans up.
    resolveApply({ ok: true, data: makeOkApplyResult(1, 2_400_000) });
    await waitFor(() => {
      expect(screen.queryByTestId('diff-table')).toBeNull();
    });
  });
});

describe('Dashboard — DF running disables buttons', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('disables sync buttons with a tooltip when getDfStatus returns running', async () => {
    installDfMock({});
    // Override window.df.process via the api stub.
    // The dashboard probes process.getDfStatus inside try/catch — we
    // replace the renderer-side api after install via direct module
    // mock since the bridge doesn't expose process yet.
    const apiModule = await import('../../src/renderer/api');
    const originalGet = apiModule.api.process.getDfStatus;
    apiModule.api.process.getDfStatus = vi.fn().mockResolvedValue({
      running: true,
      pid: 1234
    });
    try {
      render(<Dashboard />);
      await waitFor(() => {
        const btn = screen.getByTestId('sync-btn-push') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('title')).toMatch(/close df/i);
      });
      // Process status badge reflects running. Wrapped in waitFor too —
      // the badge subscribes to api.process.getDfStatus independently
      // of Dashboard, so under slower CI environments its setState can
      // arrive a tick after Dashboard's.
      await waitFor(() => {
        const badge = screen.getByTestId('process-status-badge');
        expect(badge.textContent).toMatch(/df running/i);
      });
    } finally {
      apiModule.api.process.getDfStatus = originalGet;
    }
  });
});
