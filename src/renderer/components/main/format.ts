/**
 * Tiny formatting helpers shared by dashboard sub-components.
 *
 * Phase 9 keeps these inline rather than spreading them across
 * components or pulling a util module from `shared/`. If Phase 11
 * needs them in Settings, lift them into a renderer-side `utils.ts`.
 */

const ONE_KB = 1024;
const ONE_MB = ONE_KB * 1024;
const ONE_GB = ONE_MB * 1024;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < ONE_KB) return `${bytes} B`;
  if (bytes < ONE_MB) return `${(bytes / ONE_KB).toFixed(1)} KB`;
  if (bytes < ONE_GB) return `${(bytes / ONE_MB).toFixed(1)} MB`;
  return `${(bytes / ONE_GB).toFixed(2)} GB`;
}

const RELATIVE_THRESHOLDS: { ms: number; div: number; unit: string }[] = [
  { ms: 60 * 1000, div: 1000, unit: 's' },
  { ms: 60 * 60 * 1000, div: 60 * 1000, unit: 'min' },
  { ms: 24 * 60 * 60 * 1000, div: 60 * 60 * 1000, unit: 'h' },
  { ms: 7 * 24 * 60 * 60 * 1000, div: 24 * 60 * 60 * 1000, unit: 'd' },
  { ms: 30 * 24 * 60 * 60 * 1000, div: 7 * 24 * 60 * 60 * 1000, unit: 'wk' }
];

export function formatRelative(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts)) return 'unknown';
  const diff = Math.max(0, now - ts);
  if (diff < 5 * 1000) return 'just now';
  for (const { ms, div, unit } of RELATIVE_THRESHOLDS) {
    if (diff < ms) {
      const n = Math.floor(diff / div);
      return `${n} ${unit} ago`;
    }
  }
  // Fall back to a date string for older entries.
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return 'a while ago';
  }
}

/** Truncate a string in the middle to keep both head and tail visible. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Per-kind directional icon for the diff table. */
export function kindIcon(
  kind:
    | 'push'
    | 'pull'
    | 'push-delete'
    | 'pull-delete'
    | 'conflict-newer-local'
    | 'conflict-newer-cloud'
    | 'conflict-tie'
    | 'conflict-local-deleted'
    | 'conflict-cloud-deleted'
): string {
  switch (kind) {
    case 'push':
      return '↑';
    case 'pull':
      return '↓';
    case 'push-delete':
    case 'pull-delete':
      return '✗';
    default:
      return '⚠';
  }
}

export function kindLabel(
  kind:
    | 'push'
    | 'pull'
    | 'push-delete'
    | 'pull-delete'
    | 'conflict-newer-local'
    | 'conflict-newer-cloud'
    | 'conflict-tie'
    | 'conflict-local-deleted'
    | 'conflict-cloud-deleted'
): string {
  switch (kind) {
    case 'push':
      return 'push';
    case 'pull':
      return 'pull';
    case 'push-delete':
      return 'push delete';
    case 'pull-delete':
      return 'pull delete';
    case 'conflict-newer-local':
      return 'conflict (local newer)';
    case 'conflict-newer-cloud':
      return 'conflict (cloud newer)';
    case 'conflict-tie':
      return 'conflict (tie)';
    case 'conflict-local-deleted':
      return 'conflict (local deleted)';
    case 'conflict-cloud-deleted':
      return 'conflict (cloud deleted)';
    default:
      return kind;
  }
}

/** True if a kind belongs to the conflict family (any reason). */
export function isConflictKind(
  kind:
    | 'push'
    | 'pull'
    | 'push-delete'
    | 'pull-delete'
    | 'conflict-newer-local'
    | 'conflict-newer-cloud'
    | 'conflict-tie'
    | 'conflict-local-deleted'
    | 'conflict-cloud-deleted'
): boolean {
  return kind.startsWith('conflict-');
}
