/**
 * Three-way diff engine — pure logic, zero side effects.
 *
 * Given `local`, `cloud`, and an optional `base` manifest, computes a
 * `SyncPlan` whose `items` enumerate every file that needs attention
 * per the truth table in §6.1 of the implementation plan. The diff is
 * authoritative on `sha1`; `mtimeMs` is consulted only as a tiebreaker
 * for conflict resolution (§6.2).
 *
 * Phase 4 deliverable. Phase 6 (executor) consumes the resulting plan
 * after applying conflict policy via `materializePlan` in
 * `./diff-applier.ts`. Phase 9 (UI) renders the plan in `DiffTable`.
 *
 * Design constraints (enforced by code review and the test suite):
 *
 * - **Pure.** No `fs`, no `process`, no Date.now() unless overridden by
 *   the caller via `opts.clock`. Same input → same output, modulo the
 *   non-deterministic `id` (uuid) and `createdAt` (ISO timestamp), both
 *   of which are injectable for tests.
 * - **No mutation of input manifests.** The returned plan does not
 *   alias the input arrays.
 * - **Direction filter is non-destructive.** When `direction === 'push'`
 *   we still emit pull/pull-delete items, but with `applied: false`,
 *   so the UI can show the user what they're skipping. Same applies
 *   in reverse for `'pull'`.
 * - **Conservative when no base.** Per §17 risk mitigation, when
 *   `base === null` (fresh init / lost manifest), every "present on
 *   both sides with different sha1" file becomes `conflict-tie` so
 *   the user must decide. New-on-only-one is still a clean push/pull.
 * - **Tie threshold.** When both sides changed since base AND mtimes
 *   are within `TIE_THRESHOLD_MS` (2 s), kind is `conflict-tie`
 *   regardless of policy. Otherwise the side with the larger mtime
 *   wins (`conflict-newer-local` or `conflict-newer-cloud`).
 */

import type {
  ConflictPolicy,
  FileEntry,
  Manifest,
  SyncDirection,
  SyncPlan,
  SyncPlanItem,
  SyncPlanItemKind
} from '@shared/types';

/**
 * Tie threshold in milliseconds. When both sides have changed and their
 * mtimes differ by less than this, we treat the conflict as a tie and
 * always prompt the user, regardless of `conflictPolicy`. This is the
 * rule from §6.2 of the implementation plan.
 */
export const TIE_THRESHOLD_MS = 2000;

/**
 * Options for `diff()`.
 *
 * `direction` controls which items are flagged `applied: true` in the
 * output. `conflictPolicy` is **not** consumed by `diff()` itself
 * (`materializePlan` in `diff-applier.ts` applies it); it's accepted
 * here so callers can pass it through unmodified to the next stage.
 *
 * `clock` and `uuid` are injected for testability; production callers
 * should leave them undefined and let the defaults take over.
 */
export interface DiffOptions {
  direction: SyncDirection;
  conflictPolicy: ConflictPolicy;
  /** Returns the current ISO timestamp. Defaults to `() => new Date().toISOString()`. */
  clock?: () => string;
  /** Returns a fresh plan id. Defaults to `crypto.randomUUID()`. */
  uuid?: () => string;
}

/**
 * Three-way diff producer. Returns a plan ready for either dry-run
 * inspection or `materializePlan(...)` + executor consumption.
 *
 * Implementation: O(n log n) on the union of paths across the three
 * manifests, since we sort once and walk linearly. The manifests'
 * `files` are already sorted by `rel` (Phase 3 guarantee), so the
 * union is a single merge.
 */
export function diff(
  local: Manifest,
  cloud: Manifest,
  base: Manifest | null,
  opts: DiffOptions
): SyncPlan {
  const clock = opts.clock ?? defaultClock;
  const uuid = opts.uuid ?? defaultUuid;

  const localMap = indexByRel(local.files);
  const cloudMap = indexByRel(cloud.files);
  const baseMap = base ? indexByRel(base.files) : new Map<string, FileEntry>();

  // Union of all rel paths across the three manifests, sorted for
  // deterministic output.
  const rels = new Set<string>();
  for (const e of local.files) rels.add(e.rel);
  for (const e of cloud.files) rels.add(e.rel);
  if (base) for (const e of base.files) rels.add(e.rel);
  const sortedRels = [...rels].sort();

  const items: SyncPlanItem[] = [];
  for (const rel of sortedRels) {
    const localEntry = localMap.get(rel) ?? null;
    const cloudEntry = cloudMap.get(rel) ?? null;
    const baseEntry = baseMap.get(rel) ?? null;
    const item = classify(rel, localEntry, cloudEntry, baseEntry, base !== null);
    if (item) items.push(applyDirection(item, opts.direction));
  }

  return {
    id: uuid(),
    createdAt: clock(),
    direction: opts.direction,
    items,
    summary: summarize(items)
  };
}

/* ───────────────── classification ───────────────── */

/**
 * Compute the raw `SyncPlanItem` for a single rel path. `applied` is
 * always `true` here; the direction filter is applied separately in
 * `applyDirection`. Returns `null` for the no-op case (skip).
 *
 * `hasBase` is `true` when the caller supplied a non-null base
 * manifest. When `false`, every "both sides have content" outcome
 * becomes a `conflict-tie` per §17 risk mitigation; new-on-one-side
 * cases still emit a clean push/pull because they're unambiguous.
 */
function classify(
  rel: string,
  local: FileEntry | null,
  cloud: FileEntry | null,
  base: FileEntry | null,
  hasBase: boolean
): SyncPlanItem | null {
  // Both missing — shouldn't be in the union, but guard anyway.
  if (!local && !cloud) return null;

  // Only-on-local cases.
  if (local && !cloud) {
    if (!hasBase) {
      // Fresh init: present locally, absent on cloud → push (new file).
      return makeItem(rel, 'push', local, null, base, local.size, 'new local file');
    }
    if (!base) {
      // No base entry → file is new on local since we last synced.
      return makeItem(rel, 'push', local, null, base, local.size, 'new local file');
    }
    // Base existed but cloud now missing.
    if (local.sha1 === base.sha1) {
      // Local unchanged, cloud deleted → pull-delete.
      return makeItem(
        rel,
        'pull-delete',
        local,
        null,
        base,
        local.size,
        'cloud deleted; remove local'
      );
    }
    // Local changed AND cloud deleted → conflict.
    return makeItem(
      rel,
      'conflict-cloud-deleted',
      local,
      null,
      base,
      local.size,
      'local changed but cloud was deleted'
    );
  }

  // Only-on-cloud cases.
  if (!local && cloud) {
    if (!hasBase) {
      return makeItem(rel, 'pull', null, cloud, base, cloud.size, 'new cloud file');
    }
    if (!base) {
      return makeItem(rel, 'pull', null, cloud, base, cloud.size, 'new cloud file');
    }
    if (cloud.sha1 === base.sha1) {
      // Cloud unchanged, local deleted → push-delete.
      return makeItem(
        rel,
        'push-delete',
        null,
        cloud,
        base,
        cloud.size,
        'local deleted; remove cloud'
      );
    }
    // Cloud changed AND local deleted → conflict.
    return makeItem(
      rel,
      'conflict-local-deleted',
      null,
      cloud,
      base,
      cloud.size,
      'cloud changed but local was deleted'
    );
  }

  // From here on, both `local` and `cloud` are non-null.
  // (TS narrows but we re-assert via `!` for clarity.)
  const l = local!;
  const c = cloud!;

  // Identical content — nothing to do.
  if (l.sha1 === c.sha1) return null;

  if (!hasBase) {
    // Fresh init / lost base: every "differ" is a forced prompt.
    return makeConflict(rel, l, c, base, 'no base manifest; cannot infer direction');
  }

  // From here, hasBase is true. Use the base entry (may still be null
  // if this rel didn't exist in the base manifest — i.e. created on
  // both sides since last sync).
  if (!base) {
    // Created on both sides since last sync. By definition both
    // "changed" relative to base. Treat as conflict.
    return makeConflict(rel, l, c, null, 'created on both sides since last sync');
  }

  const localChanged = l.sha1 !== base.sha1;
  const cloudChanged = c.sha1 !== base.sha1;

  if (!localChanged && !cloudChanged) {
    // sha1 differs from each other, but matches base on both? That's
    // impossible (transitivity). Defensive: emit a conflict so we
    // never silently swallow a manifest inconsistency.
    return makeConflict(
      rel,
      l,
      c,
      base,
      'manifest inconsistency: identical to base on both sides yet differ from each other'
    );
  }

  if (localChanged && !cloudChanged) {
    // Local changed since base; cloud unchanged → push.
    return makeItem(rel, 'push', l, c, base, l.size, 'local changed; push to cloud');
  }
  if (!localChanged && cloudChanged) {
    // Cloud changed; local unchanged → pull.
    return makeItem(rel, 'pull', l, c, base, c.size, 'cloud changed; pull to local');
  }

  // Both changed → conflict.
  return makeConflict(rel, l, c, base, 'both sides changed since last sync');
}

/**
 * Build a conflict item, choosing kind based on mtime delta:
 *  - within `TIE_THRESHOLD_MS` → `conflict-tie`
 *  - local mtime newer        → `conflict-newer-local`
 *  - cloud mtime newer        → `conflict-newer-cloud`
 *
 * `bytes` is the loser-side size for non-tie conflicts (since the
 * loser is what gets backed up). For ties, we use the larger of the
 * two so progress estimates don't undercount.
 */
function makeConflict(
  rel: string,
  local: FileEntry,
  cloud: FileEntry,
  base: FileEntry | null,
  reason: string
): SyncPlanItem {
  const delta = Math.abs(local.mtimeMs - cloud.mtimeMs);
  if (delta < TIE_THRESHOLD_MS) {
    const bytes = Math.max(local.size, cloud.size);
    return makeItem(
      rel,
      'conflict-tie',
      local,
      cloud,
      base,
      bytes,
      `${reason}; mtimes within ${TIE_THRESHOLD_MS}ms`
    );
  }
  if (local.mtimeMs > cloud.mtimeMs) {
    return makeItem(
      rel,
      'conflict-newer-local',
      local,
      cloud,
      base,
      cloud.size,
      `${reason}; local newer by ${delta}ms`
    );
  }
  return makeItem(
    rel,
    'conflict-newer-cloud',
    local,
    cloud,
    base,
    local.size,
    `${reason}; cloud newer by ${delta}ms`
  );
}

/**
 * Construct a `SyncPlanItem`. Centralised so all items have a uniform
 * shape and `applied` is set by the direction filter, never here.
 */
function makeItem(
  rel: string,
  kind: SyncPlanItemKind,
  local: FileEntry | null,
  cloud: FileEntry | null,
  base: FileEntry | null,
  bytes: number,
  notes: string
): SyncPlanItem {
  return {
    rel,
    kind,
    applied: true,
    bytes,
    localEntry: local,
    cloudEntry: cloud,
    baseEntry: base,
    notes
  };
}

/* ───────────────── direction filter ───────────────── */

/**
 * Mark `applied: false` for items that don't match the requested
 * direction. Conflicts are *always* applied (they need to surface in
 * the UI regardless of direction); push-only/pull-only filters affect
 * concrete actions only.
 */
function applyDirection(item: SyncPlanItem, direction: SyncDirection): SyncPlanItem {
  if (direction === 'full') return item;
  if (isConflict(item.kind)) return item;

  const isPushAction = item.kind === 'push' || item.kind === 'push-delete';
  const isPullAction = item.kind === 'pull' || item.kind === 'pull-delete';

  if (direction === 'push' && isPullAction) return { ...item, applied: false };
  if (direction === 'pull' && isPushAction) return { ...item, applied: false };
  return item;
}

/* ───────────────── helpers ───────────────── */

function indexByRel(entries: readonly FileEntry[]): Map<string, FileEntry> {
  const m = new Map<string, FileEntry>();
  for (const e of entries) m.set(e.rel, e);
  return m;
}

/** Returns true when the kind represents an unresolved conflict. */
export function isConflict(kind: SyncPlanItemKind): boolean {
  return (
    kind === 'conflict-newer-local' ||
    kind === 'conflict-newer-cloud' ||
    kind === 'conflict-tie' ||
    kind === 'conflict-local-deleted' ||
    kind === 'conflict-cloud-deleted'
  );
}

/** Aggregate counts and total bytes for the plan summary. */
function summarize(items: readonly SyncPlanItem[]): SyncPlan['summary'] {
  let pushCount = 0;
  let pullCount = 0;
  let conflictCount = 0;
  let totalBytes = 0;
  for (const it of items) {
    if (it.applied) totalBytes += it.bytes;
    if (it.kind === 'push' || it.kind === 'push-delete') pushCount += 1;
    else if (it.kind === 'pull' || it.kind === 'pull-delete') pullCount += 1;
    else if (isConflict(it.kind)) conflictCount += 1;
  }
  return { pushCount, pullCount, conflictCount, totalBytes };
}

/* ───────────────── default factories ───────────────── */

function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * Default uuid factory. We use Node's globally-available
 * `crypto.randomUUID` to avoid adding a dep. Pulled out so tests can
 * inject a deterministic factory via `opts.uuid` without mocking the
 * global.
 */
function defaultUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  // Fallback: 32 hex chars from Math.random. The default code path on
  // Node ≥ 19 and modern browsers is `crypto.randomUUID`; this fallback
  // exists only so a stripped-down test runtime still works.
  let out = '';
  for (let i = 0; i < 32; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}
