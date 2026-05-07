/**
 * Materialize a `SyncPlan` against a `ConflictPolicy`.
 *
 * Pure transform consumed by Phase 6 (executor) and Phase 9 (UI). The
 * raw output of `diff()` only marks conflicts (`conflict-newer-*`,
 * `conflict-tie`, `conflict-{local,cloud}-deleted`). Before the executor
 * can act, those conflicts must be either:
 *   1. Resolved automatically (per `newer-wins-backup`), in which case
 *      they become concrete `push` / `pull` / `push-delete` /
 *      `pull-delete` items, OR
 *   2. Flagged as `requires-prompt: true`, in which case Phase 9's UI
 *      collects a user choice and re-materialises the plan.
 *
 * `conflict-tie` is **always** prompted regardless of policy — that's
 * the rule from §6.2 of the implementation plan: when two clients save
 * the same world within 2 seconds, we never guess.
 *
 * No `fs`, no `process`, no I/O. Same-shape input ↦ same-shape output.
 *
 * The returned `prompts` array is in the same order as the conflict
 * items inside `plan.items`. Phase 9 renders it as a list dialog.
 */

import { isConflict } from './diff';
import type {
  ConflictPolicy,
  FileEntry,
  SyncPlan,
  SyncPlanItem,
  SyncPlanItemKind
} from '@shared/types';

/**
 * UI-driven choice for a single conflicted file. Phase 9 collects
 * these from the user; Phase 6 then re-runs `materializePlan` (or a
 * follow-on resolver) with the choices baked in.
 */
export type ConflictResolution = 'keep-local' | 'keep-cloud' | 'keep-both';

/**
 * One row of the prompt list returned by `materializePlan`. Each
 * conflicted item that is *not* auto-resolved produces one prompt.
 */
export interface ConflictPrompt {
  rel: string;
  kind: SyncPlanItemKind;
  /**
   * Allowed resolutions for this prompt. Always includes both
   * `keep-local` and `keep-cloud`; `keep-both` is offered when both
   * sides have content (so the dialog can rename one of them).
   */
  options: ConflictResolution[];
  /** When `true`, the executor should snapshot **both** sides before
   *  proceeding (the user explicitly opted out of auto-resolution
   *  and just wants safe backups taken). Set under
   *  `'backup-only-no-resolve'`. */
  snapshotBoth?: boolean;
}

/**
 * Output of `materializePlan`. The plan is a *new* `SyncPlan` whose
 * conflict items either:
 *
 * - Have been rewritten to a concrete kind (push / pull / push-delete /
 *   pull-delete) with `applied: true`, OR
 * - Retain a conflict kind but with `applied: false` and a flag
 *   recorded in `prompts` requesting user input.
 *
 * Items that were already concrete (push/pull/etc) pass through
 * unchanged.
 */
export interface MaterializedPlan {
  plan: SyncPlan;
  prompts: ConflictPrompt[];
}

/**
 * Apply a conflict policy to a plan. The input plan is not mutated;
 * the returned plan has fresh items + a recomputed summary.
 *
 * Policy semantics (matches §6.2 of the implementation plan):
 *
 * - `'newer-wins-backup'` — auto-resolves `conflict-newer-local` →
 *   `push` (cloud loses, will be backed up by Phase 5) and
 *   `conflict-newer-cloud` → `pull`. `conflict-tie` always prompts.
 *   `conflict-{local,cloud}-deleted` always prompts (deletion-vs-edit
 *   is too consequential to auto-resolve, even if mtimes are clear).
 *
 * - `'always-prompt'` — every conflict-* item gets a prompt, even
 *   when newer/older mtimes would otherwise resolve cleanly.
 *
 * - `'backup-only-no-resolve'` — like `'always-prompt'` but every
 *   prompt is annotated `snapshotBoth: true` so the executor knows
 *   to back up both sides before any user-driven write. Phase 6
 *   uses that flag to seed the backup session.
 */
export function materializePlan(plan: SyncPlan, policy: ConflictPolicy): MaterializedPlan {
  const prompts: ConflictPrompt[] = [];
  const newItems: SyncPlanItem[] = [];

  for (const item of plan.items) {
    if (!isConflict(item.kind)) {
      // Non-conflict items pass through unchanged.
      newItems.push(item);
      continue;
    }

    // Tie always prompts regardless of policy.
    if (item.kind === 'conflict-tie') {
      const prompt = makePrompt(item, policy === 'backup-only-no-resolve');
      prompts.push(prompt);
      newItems.push({ ...item, applied: false });
      continue;
    }

    if (policy === 'newer-wins-backup') {
      const resolved = autoResolve(item);
      if (resolved) {
        newItems.push(resolved);
        continue;
      }
      // No clean auto-resolution available (e.g. one of the
      // conflict-{local,cloud}-deleted variants): fall through to
      // prompt.
      const prompt = makePrompt(item, false);
      prompts.push(prompt);
      newItems.push({ ...item, applied: false });
      continue;
    }

    // 'always-prompt' or 'backup-only-no-resolve' — surface every
    // conflict to the user.
    const prompt = makePrompt(item, policy === 'backup-only-no-resolve');
    prompts.push(prompt);
    newItems.push({ ...item, applied: false });
  }

  return {
    plan: {
      ...plan,
      items: newItems,
      summary: recomputeSummary(newItems)
    },
    prompts
  };
}

/* ───────────────── auto-resolution ───────────────── */

/**
 * Resolve a `conflict-newer-*` item under `newer-wins-backup`. Returns
 * `null` for kinds that should never be auto-resolved (ties — handled
 * upstream — and the deleted-side variants, which need user input).
 */
function autoResolve(item: SyncPlanItem): SyncPlanItem | null {
  if (item.kind === 'conflict-newer-local') {
    // Local is newer → push to cloud. Cloud loses; Phase 5/6 will
    // back it up before overwrite. The mover bytes are the local
    // file's size.
    const local = item.localEntry;
    if (!local) return null; // defensive
    return {
      ...item,
      kind: 'push',
      bytes: local.size,
      notes: `auto-resolved (newer-wins-backup): local newer; ${item.notes ?? ''}`.trim()
    };
  }
  if (item.kind === 'conflict-newer-cloud') {
    // Cloud is newer → pull. Local will be backed up first.
    const cloud = item.cloudEntry;
    if (!cloud) return null;
    return {
      ...item,
      kind: 'pull',
      bytes: cloud.size,
      notes: `auto-resolved (newer-wins-backup): cloud newer; ${item.notes ?? ''}`.trim()
    };
  }
  // Ties and deleted-side conflicts can't be auto-resolved.
  return null;
}

/* ───────────────── prompts ───────────────── */

/**
 * Build a `ConflictPrompt` for a conflict-kind item.
 *
 * `keep-both` is offered only when both sides actually have content
 * (so the UI can present "rename one"); `conflict-{local,cloud}-deleted`
 * has only one content side, so `keep-both` is meaningless there.
 */
function makePrompt(item: SyncPlanItem, snapshotBoth: boolean): ConflictPrompt {
  const options: ConflictResolution[] = ['keep-local', 'keep-cloud'];
  if (hasContent(item.localEntry) && hasContent(item.cloudEntry)) {
    options.push('keep-both');
  }
  const prompt: ConflictPrompt = {
    rel: item.rel,
    kind: item.kind,
    options
  };
  if (snapshotBoth) prompt.snapshotBoth = true;
  return prompt;
}

function hasContent(entry: FileEntry | null): boolean {
  return entry !== null;
}

/* ───────────────── summary recomputation ───────────────── */

/**
 * Re-aggregate counts after the policy pass. Mirrors the logic in
 * `diff.ts#summarize`, but kept local here so changes to the conflict
 * accounting on either side stay obviously paired.
 */
function recomputeSummary(items: readonly SyncPlanItem[]): SyncPlan['summary'] {
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
