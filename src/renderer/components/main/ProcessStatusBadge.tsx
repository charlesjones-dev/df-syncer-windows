import { useEffect, useState } from 'react';
import type { DfState } from '@shared/types';
import { api } from '../../api';

/**
 * ProcessStatusBadge — Phase 10.
 *
 * Phase 10 wires the real `api.process.getDfStatus()` /
 * `api.process.onStateChange(cb)` IPC. This component subscribes once
 * on mount and keeps its `Status` in sync.
 *
 * The probe is still wrapped in try/catch so the dashboard renders
 * without crashing in test environments that mock only a subset of
 * `window.df` (the renderer test suite doesn't always install the
 * `process` namespace).
 */

export type ProcessStatusBadgeProps = {
  /** Optional override for tests / Phase 10 to force a state. */
  state?: DfState | null;
};

type Status = { kind: 'unknown' } | { kind: 'idle' } | { kind: 'running'; pid?: number };

function deriveStatus(state: DfState | null | undefined): Status {
  if (!state) return { kind: 'unknown' };
  if (state.running) return { kind: 'running', pid: state.pid };
  return { kind: 'idle' };
}

export function ProcessStatusBadge(props: ProcessStatusBadgeProps): JSX.Element {
  const [status, setStatus] = useState<Status>(deriveStatus(props.state));

  useEffect(() => {
    if (props.state !== undefined) {
      setStatus(deriveStatus(props.state));
      return;
    }
    let cancelled = false;
    let unsub: (() => void) | null = null;

    // Read the current state once on mount.
    (async () => {
      try {
        const s = await api.process.getDfStatus();
        if (!cancelled) setStatus(deriveStatus(s));
      } catch {
        // Test envs without the process bridge — stay 'unknown'.
      }
    })();

    // Subscribe to live transitions.
    try {
      const fn = api.process.onStateChange;
      if (typeof fn === 'function') {
        unsub = fn((s) => {
          if (!cancelled) setStatus(deriveStatus(s));
        });
      }
    } catch {
      // Subscription not available in this env.
    }

    return () => {
      cancelled = true;
      if (unsub) {
        try {
          unsub();
        } catch {
          // Ignore.
        }
      }
    };
  }, [props.state]);

  const cls =
    status.kind === 'running'
      ? 'status-badge status-badge--running'
      : status.kind === 'idle'
        ? 'status-badge status-badge--idle'
        : 'status-badge status-badge--unknown';

  const label =
    status.kind === 'running'
      ? `DF running${status.pid ? ` (pid ${status.pid})` : ''}`
      : status.kind === 'idle'
        ? 'DF idle'
        : 'DF state unknown';

  return (
    <span className={cls} role="status" aria-label={label} data-testid="process-status-badge">
      <span className="status-badge__dot" aria-hidden="true" />
      <span className="status-badge__label">{label}</span>
    </span>
  );
}

/** Exported for siblings that need the same kind without re-deriving. */
export function dfRunningFromState(state: DfState | null | undefined): boolean {
  return state ? state.running : false;
}
