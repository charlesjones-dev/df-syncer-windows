import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_PUSH_COOLDOWN_MS,
  DEFAULT_COOLDOWN_MS,
  DF_PROCESS_NAME,
  ProcessMonitor,
  findDf
} from '../../src/main/process-monitor';
import { computeRolling7DayAverage, computeRollingAverage } from '../../src/main/tray';
import type { DfStateChange, SyncHistoryEntry } from '../../src/shared/types';

/**
 * Phase 10 — process monitor tests.
 *
 * We don't mock `ps-list` via `vi.mock` because the monitor accepts an
 * injectable `psList` factory in `ProcessMonitorOptions`. This is
 * cleaner: the test holds a reference to the latest fake list and the
 * monitor reads it on every poll, no module-level global to reset.
 *
 * Timer control: `vi.useFakeTimers()` drives the poll interval and the
 * cooldown timer. The monitor's `setTimer` / `clearTimer` indirection
 * isn't needed here because `vi.useFakeTimers()` patches both
 * `setTimeout` and `setInterval` on the global object.
 */

type Process = { pid: number; name: string };

function makeMonitor(opts?: { pollIntervalMs?: number; cooldownMs?: number }) {
  const list: { current: Process[] } = { current: [] };
  const monitor = new ProcessMonitor({
    pollIntervalMs: opts?.pollIntervalMs ?? 100,
    cooldownMs: opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    psList: async () => list.current
  });
  const events: DfStateChange[] = [];
  monitor.on('state-change', (s) => events.push(s));
  return { monitor, list, events };
}

describe('findDf', () => {
  it('matches Dwarf Fortress.exe case-insensitively', () => {
    expect(findDf([{ pid: 1, name: 'Dwarf Fortress.exe' }])).toEqual({
      pid: 1,
      name: 'Dwarf Fortress.exe'
    });
    expect(findDf([{ pid: 2, name: 'dwarf fortress.exe' }])).toEqual({
      pid: 2,
      name: 'dwarf fortress.exe'
    });
    expect(findDf([{ pid: 3, name: 'DWARF FORTRESS.EXE' }])).toEqual({
      pid: 3,
      name: 'DWARF FORTRESS.EXE'
    });
    expect(findDf([{ pid: 4, name: 'Dwarf Fortress.EXE' }])).toEqual({
      pid: 4,
      name: 'Dwarf Fortress.EXE'
    });
  });

  it('does not match unrelated processes', () => {
    expect(findDf([{ pid: 1, name: 'notepad.exe' }])).toBeNull();
    expect(findDf([{ pid: 2, name: 'dwarffortress.exe' }])).toBeNull();
    expect(findDf([{ pid: 3, name: 'Dwarf Fortress' }])).toBeNull();
  });

  it('returns the first match in a populated list', () => {
    const list: Process[] = [
      { pid: 1, name: 'explorer.exe' },
      { pid: 2, name: 'Dwarf Fortress.exe' },
      { pid: 3, name: 'chrome.exe' }
    ];
    expect(findDf(list)).toEqual({ pid: 2, name: DF_PROCESS_NAME });
  });
});

describe('ProcessMonitor — Idle state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays Idle when ps-list returns no DF', async () => {
    const { monitor, list, events } = makeMonitor();
    list.current = [{ pid: 100, name: 'explorer.exe' }];
    monitor.start();
    // First poll fires immediately (start() kicks one off non-awaited).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual([]);
    expect(monitor.getStatus()).toEqual({ running: false });
    monitor.dispose();
  });
});

describe('ProcessMonitor — Idle → Running', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits running:true with pid + since when DF appears', async () => {
    const { monitor, list, events } = makeMonitor();
    monitor.start();
    list.current = [{ pid: 4242, name: 'Dwarf Fortress.exe' }];
    // Allow the immediate poll to run + advance to next interval.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = events[0];
    expect(first.running).toBe(true);
    expect(first.pid).toBe(4242);
    expect(first.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.prompt).toBe('on-start');
    expect(monitor.getStatus().running).toBe(true);
    monitor.dispose();
  });
});

describe('ProcessMonitor — Running → Idle (cooldown)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits running:false immediately, then on-exit prompt after cooldown', async () => {
    const { monitor, list, events } = makeMonitor({ cooldownMs: 15_000 });
    list.current = [{ pid: 7, name: 'Dwarf Fortress.exe' }];
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(events.some((e) => e.running && e.prompt === 'on-start')).toBe(true);
    events.length = 0;

    // DF disappears.
    list.current = [];
    await vi.advanceTimersByTimeAsync(150);
    // Should have one running:false event without prompt.
    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = events[0];
    expect(first.running).toBe(false);
    expect(first.prompt).toBeUndefined();

    // No on-exit yet.
    expect(events.some((e) => e.prompt === 'on-exit')).toBe(false);

    // Advance past the cooldown.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.some((e) => e.prompt === 'on-exit' && e.running === false)).toBe(true);
    monitor.dispose();
  });

  it('cancels the cooldown if DF reappears before it fires', async () => {
    const { monitor, list, events } = makeMonitor({ cooldownMs: 5000 });
    list.current = [{ pid: 7, name: 'Dwarf Fortress.exe' }];
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    events.length = 0;

    // Exit.
    list.current = [];
    await vi.advanceTimersByTimeAsync(150);

    // Re-enter before cooldown fires.
    list.current = [{ pid: 8, name: 'Dwarf Fortress.exe' }];
    await vi.advanceTimersByTimeAsync(150);

    // Now wait long enough for the (cancelled) cooldown.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.some((e) => e.prompt === 'on-exit')).toBe(false);
    expect(events.some((e) => e.running && e.prompt === 'on-start')).toBe(true);
    monitor.dispose();
  });
});

describe('ProcessMonitor — pause/resume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not emit while paused; resume re-broadcasts latest state', async () => {
    const { monitor, list, events } = makeMonitor();
    list.current = [{ pid: 10, name: 'Dwarf Fortress.exe' }];
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(events.length).toBeGreaterThanOrEqual(1);
    events.length = 0;

    monitor.pause();
    expect(monitor.isPaused).toBe(true);

    // Even if DF state changes, no events while paused.
    list.current = [];
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(20_000); // past cooldown.
    expect(events).toEqual([]);

    // Resume re-emits the latest known state (which is `running: false`
    // post-cooldown because polling kept ticking).
    monitor.resume();
    expect(monitor.isPaused).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0].running).toBe(false);
    monitor.dispose();
  });
});

describe('ProcessMonitor — setPollInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('changes the poll cadence at runtime', async () => {
    const { monitor, list, events } = makeMonitor({ pollIntervalMs: 500 });
    list.current = [{ pid: 1, name: 'Dwarf Fortress.exe' }];
    monitor.start();
    await vi.advanceTimersByTimeAsync(600); // first interval tick.
    expect(events.length).toBeGreaterThanOrEqual(1);
    events.length = 0;

    // Speed up to 50ms; new state changes should be observed faster.
    monitor.setPollInterval(50);
    list.current = [];
    await vi.advanceTimersByTimeAsync(60);
    expect(events.some((e) => e.running === false)).toBe(true);
    monitor.dispose();
  });

  it('rejects non-positive intervals', () => {
    const { monitor } = makeMonitor();
    expect(() => monitor.setPollInterval(0)).toThrow();
    expect(() => monitor.setPollInterval(-1)).toThrow();
    monitor.dispose();
  });
});

describe('ProcessMonitor — getStatus / dispose', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the latest observation synchronously', async () => {
    const { monitor, list } = makeMonitor();
    expect(monitor.getStatus()).toEqual({ running: false });
    list.current = [{ pid: 99, name: 'Dwarf Fortress.exe' }];
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    const s = monitor.getStatus();
    expect(s.running).toBe(true);
    expect(s.pid).toBe(99);
    monitor.dispose();
  });

  it('dispose stops polling and removes listeners', async () => {
    const { monitor, list, events } = makeMonitor();
    list.current = [{ pid: 1, name: 'Dwarf Fortress.exe' }];
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    monitor.dispose();
    events.length = 0;

    // Subsequent polls (timer is cleared) shouldn't fire even if list
    // changes.
    list.current = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([]);
  });
});

describe('computeRolling7DayAverage', () => {
  const NOW = Date.parse('2026-05-07T12:00:00.000Z');

  function entry(timestampIso: string, bytes: number, ok = true): SyncHistoryEntry {
    return {
      timestamp: timestampIso,
      direction: 'push',
      result: {
        planId: 'p',
        startedAt: timestampIso,
        completedAt: timestampIso,
        direction: 'push',
        dryRun: false,
        ok,
        applied: 1,
        skipped: 0,
        conflicts: [],
        bytesWritten: bytes,
        backupCount: 0
      }
    };
  }

  it('returns 0 for empty history', () => {
    expect(computeRolling7DayAverage([], NOW)).toBe(0);
  });

  it('averages bytes across the 7-day window divided by N=7', () => {
    const h: SyncHistoryEntry[] = [
      entry('2026-05-06T12:00:00.000Z', 1_000_000),
      entry('2026-05-04T12:00:00.000Z', 2_000_000),
      entry('2026-05-01T12:00:00.000Z', 4_000_000)
    ];
    // Total = 7,000,000, / 7 days = 1,000,000.
    expect(computeRolling7DayAverage(h, NOW)).toBe(1_000_000);
  });

  it('drops entries outside the window', () => {
    const h: SyncHistoryEntry[] = [
      entry('2026-04-01T12:00:00.000Z', 999_000_000), // outside.
      entry('2026-05-06T12:00:00.000Z', 1_400_000)
    ];
    expect(computeRolling7DayAverage(h, NOW)).toBe(200_000);
  });

  it('ignores failed runs', () => {
    const h: SyncHistoryEntry[] = [
      entry('2026-05-06T12:00:00.000Z', 1_000_000, false),
      entry('2026-05-05T12:00:00.000Z', 7_000_000)
    ];
    expect(computeRolling7DayAverage(h, NOW)).toBe(1_000_000);
  });

  it('parses Windows-safe timestamp format too', () => {
    const h: SyncHistoryEntry[] = [
      // `buildTimestamp()` shape: colons replaced with hyphens.
      entry('2026-05-06T12-00-00-000Z', 7_000_000)
    ];
    expect(computeRolling7DayAverage(h, NOW)).toBe(1_000_000);
  });

  it('exposes a generalised rolling-N variant', () => {
    const h: SyncHistoryEntry[] = [entry('2026-05-06T12:00:00.000Z', 14_000_000)];
    // Over 14 days → 1,000,000.
    expect(computeRollingAverage(h, 14, NOW)).toBe(1_000_000);
    // Zero / negative N → 0 (heuristic disabled).
    expect(computeRollingAverage(h, 0, NOW)).toBe(0);
    expect(computeRollingAverage(h, -1, NOW)).toBe(0);
  });
});

describe('cooldown constants', () => {
  it('export sane defaults', () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(15_000);
    expect(AUTO_PUSH_COOLDOWN_MS).toBe(5_000);
  });
});
