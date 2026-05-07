import { useEffect, useMemo, useRef, useState } from 'react';
import type { SyncPlan, SyncPlanItem, SyncPlanItemKind, SyncProgress } from '@shared/types';
import { formatBytes, isConflictKind, kindIcon, kindLabel, truncateMiddle } from './format';

/**
 * DiffTable — renders a `SyncPlan` for the user to inspect, with a
 * virtualized scroll body so 10k-item plans don't tank the renderer.
 *
 * Mode:
 *  - `preview`: shows Apply / Cancel buttons. Apply is hidden if any
 *    `applied: true` conflict kind survives.
 *  - `dryrun`: read-only; no Apply.
 *
 * Sorting:
 *  - Conflicts pinned first, then push, then pull, then deletes.
 *  - Within a group, items keep the engine's `rel`-ASC order.
 *
 * Virtualization:
 *  - Hand-rolled windowing (no `react-window` dep). The list area has a
 *    fixed inner height equal to `items.length * ROW_HEIGHT_PX`; only
 *    the rows whose y-band intersects the viewport are mounted. This
 *    keeps the bundle small and avoids the `minimum-release-age`
 *    install delay for a new dep.
 */

const ROW_HEIGHT_PX = 32;
const VIEWPORT_HEIGHT_PX = 320;
const OVERSCAN = 6;

export type DiffTableMode = 'preview' | 'dryrun';

export type DiffTableFilter = 'all' | 'push' | 'pull' | 'conflicts';

export type DiffTableProps = {
  plan: SyncPlan;
  mode: DiffTableMode;
  /** Truthy while a `sync.apply` is in flight. */
  inProgress?: boolean;
  /** Latest progress event from `sync.onProgress`, if any. */
  progress?: SyncProgress | null;
  /** Click handler for Apply (preview only). */
  onApply?: () => void;
  /** Click handler for Cancel — clears the plan, no IPC. */
  onCancel?: () => void;
  /** Click handler for cancelling an in-flight apply. */
  onAbort?: () => void;
};

export function DiffTable(props: DiffTableProps): JSX.Element {
  const [filter, setFilter] = useState<DiffTableFilter>('all');

  const sortedItems = useMemo(() => sortPlanItems(props.plan.items), [props.plan.items]);
  const filteredItems = useMemo(() => filterPlanItems(sortedItems, filter), [sortedItems, filter]);

  const summary = props.plan.summary;
  const hasUnresolvedConflict = props.plan.items.some((i) => isConflictKind(i.kind) && i.applied);
  const showApply =
    props.mode === 'preview' && typeof props.onApply === 'function' && !hasUnresolvedConflict;

  return (
    <section className="diff-table" aria-labelledby="diff-table-heading" data-testid="diff-table">
      <header className="diff-table__header">
        <h2 id="diff-table-heading" className="diff-table__title">
          Plan preview ({props.plan.items.length} change{props.plan.items.length === 1 ? '' : 's'})
        </h2>
        <ul className="diff-table__summary" aria-label="Summary counts">
          <li data-testid="diff-summary-push">
            <span className="diff-table__summary-num">{summary.pushCount}</span> push
          </li>
          <li data-testid="diff-summary-pull">
            <span className="diff-table__summary-num">{summary.pullCount}</span> pull
          </li>
          <li data-testid="diff-summary-conflict">
            <span className="diff-table__summary-num">{summary.conflictCount}</span> conflict
          </li>
          <li data-testid="diff-summary-bytes">
            <span className="diff-table__summary-num">{formatBytes(summary.totalBytes)}</span> total
          </li>
        </ul>
        <FilterDropdown value={filter} onChange={setFilter} />
      </header>

      {props.inProgress && props.progress && <ProgressBar progress={props.progress} />}

      {filteredItems.length === 0 ? (
        <p className="diff-table__empty" data-testid="diff-table-empty">
          {props.plan.items.length === 0
            ? 'Nothing to sync — local and cloud are already in agreement.'
            : 'No items match the current filter.'}
        </p>
      ) : (
        <VirtualList items={filteredItems} />
      )}

      <footer className="diff-table__footer">
        {props.mode === 'dryrun' && (
          <span className="diff-table__note" data-testid="diff-table-dryrun-note">
            Read-only — dry run never applies.
          </span>
        )}
        {hasUnresolvedConflict && props.mode === 'preview' && (
          <span
            className="diff-table__note diff-table__note--warn"
            data-testid="diff-table-blocked-note"
          >
            Resolve conflicts before applying.
          </span>
        )}
        <div className="diff-table__footer-spacer" />
        {props.inProgress ? (
          <button
            type="button"
            className="diff-table__btn diff-table__btn--danger"
            onClick={props.onAbort}
            data-testid="diff-table-abort"
          >
            Cancel sync
          </button>
        ) : (
          <>
            {props.mode === 'preview' && props.onCancel && (
              <button
                type="button"
                className="diff-table__btn"
                onClick={props.onCancel}
                data-testid="diff-table-cancel"
              >
                Discard plan
              </button>
            )}
            {showApply && (
              <button
                type="button"
                className="diff-table__btn diff-table__btn--primary"
                onClick={props.onApply}
                data-testid="diff-table-apply"
                disabled={props.plan.items.length === 0}
              >
                Apply
              </button>
            )}
          </>
        )}
      </footer>
    </section>
  );
}

/* ──────────────────────────── filter ──────────────────────────── */

function FilterDropdown(props: {
  value: DiffTableFilter;
  onChange: (next: DiffTableFilter) => void;
}): JSX.Element {
  return (
    <label className="diff-table__filter">
      <span className="visually-hidden">Filter</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as DiffTableFilter)}
        data-testid="diff-table-filter"
      >
        <option value="all">All</option>
        <option value="push">Push</option>
        <option value="pull">Pull</option>
        <option value="conflicts">Conflicts</option>
      </select>
    </label>
  );
}

function filterPlanItems(items: readonly SyncPlanItem[], f: DiffTableFilter): SyncPlanItem[] {
  switch (f) {
    case 'all':
      return [...items];
    case 'push':
      return items.filter((i) => i.kind === 'push' || i.kind === 'push-delete');
    case 'pull':
      return items.filter((i) => i.kind === 'pull' || i.kind === 'pull-delete');
    case 'conflicts':
      return items.filter((i) => isConflictKind(i.kind));
    default:
      return [...items];
  }
}

function sortPlanItems(items: readonly SyncPlanItem[]): SyncPlanItem[] {
  // Stable sort: conflict (0) → push (1) → pull (2) → delete (3).
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const ka = groupKey(a.item.kind);
      const kb = groupKey(b.item.kind);
      if (ka !== kb) return ka - kb;
      return a.idx - b.idx;
    })
    .map(({ item }) => item);
}

function groupKey(kind: SyncPlanItemKind): number {
  if (isConflictKind(kind)) return 0;
  if (kind === 'push') return 1;
  if (kind === 'pull') return 2;
  return 3;
}

/* ──────────────────────────── virtualization ──────────────────────────── */

function VirtualList(props: { items: SyncPlanItem[] }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onScroll = (): void => setScrollTop(node.scrollTop);
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  const totalHeight = props.items.length * ROW_HEIGHT_PX;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX) + OVERSCAN * 2;
  const endIndex = Math.min(props.items.length, startIndex + visibleCount);
  const offset = startIndex * ROW_HEIGHT_PX;

  const slice = props.items.slice(startIndex, endIndex);

  return (
    <div
      className="diff-table__list"
      ref={containerRef}
      role="list"
      aria-label="Plan items"
      style={{ height: VIEWPORT_HEIGHT_PX }}
      data-testid="diff-table-list"
    >
      <div className="diff-table__list-spacer" style={{ height: totalHeight }}>
        <div className="diff-table__list-window" style={{ transform: `translateY(${offset}px)` }}>
          {slice.map((item) => (
            <DiffRow key={item.rel} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DiffRow(props: { item: SyncPlanItem }): JSX.Element {
  const { item } = props;
  const conflict = isConflictKind(item.kind);
  const tooltip = buildRowTooltip(item);

  return (
    <div
      className={[
        'diff-table__row',
        `diff-table__row--${item.kind}`,
        conflict ? 'diff-table__row--conflict' : '',
        !item.applied ? 'diff-table__row--inactive' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      role="listitem"
      title={tooltip}
      style={{ height: ROW_HEIGHT_PX }}
      data-testid="diff-table-row"
      data-kind={item.kind}
    >
      <span className="diff-table__row-icon" aria-hidden="true">
        {kindIcon(item.kind)}
      </span>
      <span className="diff-table__row-rel" title={item.rel}>
        {truncateMiddle(item.rel, 64)}
      </span>
      <span className="diff-table__row-kind">{kindLabel(item.kind)}</span>
      <span className="diff-table__row-bytes">{formatBytes(item.bytes)}</span>
    </div>
  );
}

function buildRowTooltip(item: SyncPlanItem): string {
  const parts: string[] = [item.rel];
  if (item.localEntry) {
    parts.push(
      `local: sha1=${item.localEntry.sha1.slice(0, 8)} mtime=${new Date(item.localEntry.mtimeMs).toLocaleString()}`
    );
  }
  if (item.cloudEntry) {
    parts.push(
      `cloud: sha1=${item.cloudEntry.sha1.slice(0, 8)} mtime=${new Date(item.cloudEntry.mtimeMs).toLocaleString()}`
    );
  }
  if (item.localEntry && item.cloudEntry) {
    const delta = item.localEntry.mtimeMs - item.cloudEntry.mtimeMs;
    parts.push(`Δmtime=${formatMillis(delta)}`);
  }
  if (item.notes) parts.push(item.notes);
  return parts.join('\n');
}

function formatMillis(ms: number): string {
  const sign = ms >= 0 ? '+' : '−';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${abs} ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)} s`;
  if (abs < 3600_000) return `${sign}${(abs / 60_000).toFixed(1)} min`;
  return `${sign}${(abs / 3600_000).toFixed(1)} h`;
}

/* ──────────────────────────── progress bar ──────────────────────────── */

function ProgressBar(props: { progress: SyncProgress }): JSX.Element {
  const { progress } = props;
  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.index / progress.total) * 100)) : 0;
  return (
    <div
      className="diff-table__progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.index}
      aria-label={`Sync progress: ${progress.phase}`}
      data-testid="diff-table-progress"
    >
      <div className="diff-table__progress-bar" style={{ width: `${pct}%` }} />
      <span className="diff-table__progress-label">
        {progress.phase}
        {progress.total > 0 ? ` ${progress.index}/${progress.total}` : ''}
        {progress.currentRel ? ` — ${truncateMiddle(progress.currentRel, 60)}` : ''}
      </span>
    </div>
  );
}
