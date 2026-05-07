import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { DEFAULT_EXCLUDE_GLOBS, PREFS_INIT_TXT_GLOB, type Step4Payload } from '../../state/store';
import type { EnabledFolders } from '@shared/types';

/**
 * Step 4 — Sync Selection.
 *
 * Per spec §8 / §5.1:
 *  - Default `enabledFolders`: data OFF, mods/prefs/save ON.
 *  - "Treat `prefs/init.txt` as machine-local" toggle, default ON when
 *    `prefs` is enabled. Adds/removes the glob from `excludeGlobs`.
 *  - Per-folder size estimates via `api.paths.estimateSize`. Cached
 *    per absolute path on the main side so toggling is cheap.
 *
 * The component owns no state outside `enabledFolders`, the init.txt
 * toggle, and the per-folder size cache. The wizard reducer holds the
 * draft; we reflect changes via `onChange(payload)`.
 */
export type Step4SyncSelectionProps = {
  gameFolder: string;
  enabledFolders: EnabledFolders | undefined;
  excludeGlobs: string[] | undefined;
  onChange: (payload: Step4Payload) => void;
};

type FolderKey = keyof EnabledFolders;

const FOLDER_DEFINITIONS: ReadonlyArray<{
  key: FolderKey;
  label: string;
  description: string;
  defaultOn: boolean;
}> = [
  {
    key: 'save',
    label: 'save/',
    description: 'Your fortresses, adventurers, and worlds.',
    defaultOn: true
  },
  {
    key: 'mods',
    label: 'mods/',
    description: 'Mods you have installed locally.',
    defaultOn: true
  },
  {
    key: 'prefs',
    label: 'prefs/',
    description: 'Keybindings, announcements, and user preferences.',
    defaultOn: true
  },
  {
    key: 'data',
    label: 'data/',
    description: 'Mostly the game install. Only enable if you customize data/installed_mods/.',
    defaultOn: false
  }
];

const DEFAULT_ENABLED: EnabledFolders = {
  data: false,
  mods: true,
  prefs: true,
  save: true
};

const ONE_KB = 1024;
const ONE_MB = ONE_KB * 1024;
const ONE_GB = ONE_MB * 1024;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < ONE_KB) return `${bytes} B`;
  if (bytes < ONE_MB) return `${(bytes / ONE_KB).toFixed(1)} KB`;
  if (bytes < ONE_GB) return `${(bytes / ONE_MB).toFixed(1)} MB`;
  return `${(bytes / ONE_GB).toFixed(2)} GB`;
}

type SizeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; bytes: number; fileCount: number }
  | { status: 'error'; message: string };

export function Step4SyncSelection(props: Step4SyncSelectionProps): JSX.Element {
  // On first mount the draft may have no enabledFolders / excludeGlobs;
  // seed defaults and dispatch once so the parent reducer reflects them.
  const enabledFolders = props.enabledFolders ?? DEFAULT_ENABLED;
  const excludeGlobs = useMemo(
    () => props.excludeGlobs ?? [...DEFAULT_EXCLUDE_GLOBS],
    [props.excludeGlobs]
  );
  const initTxtMachineLocal = excludeGlobs.includes(PREFS_INIT_TXT_GLOB);

  const [sizes, setSizes] = useState<Record<FolderKey, SizeState>>({
    data: { status: 'idle' },
    mods: { status: 'idle' },
    prefs: { status: 'idle' },
    save: { status: 'idle' }
  });

  // Seed defaults on mount if the draft is empty. Default toggle for
  // init.txt: ON when prefs is enabled and the glob isn't already
  // present.
  useEffect(() => {
    const draftHadEnabled = props.enabledFolders !== undefined;
    const draftHadExcludes = props.excludeGlobs !== undefined;
    if (draftHadEnabled && draftHadExcludes) return;
    const seededEnabled = props.enabledFolders ?? DEFAULT_ENABLED;
    let seededExcludes = props.excludeGlobs ?? [...DEFAULT_EXCLUDE_GLOBS];
    if (seededEnabled.prefs && !seededExcludes.includes(PREFS_INIT_TXT_GLOB)) {
      seededExcludes = [...seededExcludes, PREFS_INIT_TXT_GLOB];
    }
    props.onChange({ enabledFolders: seededEnabled, excludeGlobs: seededExcludes });
    // Run once on mount; subsequent renders reflect the parent's draft.
  }, []);

  // Estimate sizes for each subfolder when `gameFolder` changes. Each
  // request is independent so a slow folder doesn't block the others.
  useEffect(() => {
    if (!props.gameFolder) return;
    let cancelled = false;
    const dispatchSize = (key: FolderKey, next: SizeState): void => {
      if (cancelled) return;
      setSizes((prev) => ({ ...prev, [key]: next }));
    };
    for (const folder of FOLDER_DEFINITIONS) {
      const sub = `${props.gameFolder.replace(/[\\/]+$/, '')}/${folder.key}`;
      dispatchSize(folder.key, { status: 'loading' });
      void api.paths
        .estimateSize(sub)
        .then((res) => {
          dispatchSize(folder.key, {
            status: 'ok',
            bytes: res.bytes,
            fileCount: res.fileCount
          });
        })
        .catch((err: unknown) => {
          dispatchSize(folder.key, {
            status: 'error',
            message: err instanceof Error ? err.message : String(err)
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [props.gameFolder]);

  function handleToggleFolder(key: FolderKey): void {
    const nextEnabled: EnabledFolders = {
      ...enabledFolders,
      [key]: !enabledFolders[key]
    };
    let nextExcludes = excludeGlobs;
    // If turning prefs OFF, remove the init.txt rule too — it's only
    // meaningful when prefs is being synced.
    if (key === 'prefs' && !nextEnabled.prefs) {
      nextExcludes = nextExcludes.filter((g) => g !== PREFS_INIT_TXT_GLOB);
    }
    // If turning prefs ON and the toggle was previously hidden, restore
    // the default-ON behavior of the init.txt rule.
    if (key === 'prefs' && nextEnabled.prefs && !nextExcludes.includes(PREFS_INIT_TXT_GLOB)) {
      nextExcludes = [...nextExcludes, PREFS_INIT_TXT_GLOB];
    }
    props.onChange({ enabledFolders: nextEnabled, excludeGlobs: nextExcludes });
  }

  function handleToggleInitTxt(): void {
    const nextOn = !initTxtMachineLocal;
    let nextExcludes: string[];
    if (nextOn) {
      nextExcludes = excludeGlobs.includes(PREFS_INIT_TXT_GLOB)
        ? excludeGlobs
        : [...excludeGlobs, PREFS_INIT_TXT_GLOB];
    } else {
      nextExcludes = excludeGlobs.filter((g) => g !== PREFS_INIT_TXT_GLOB);
    }
    props.onChange({ enabledFolders, excludeGlobs: nextExcludes });
  }

  return (
    <section className="wizard-step wizard-step--sync" aria-labelledby="step4-heading">
      <h2 id="step4-heading" className="wizard-step__heading">
        Choose what to sync
      </h2>
      <p className="wizard-step__copy">
        df-syncer-windows mirrors only the subfolders you tick. You can change this later in Settings.
      </p>

      <ul className="step4__list" role="group" aria-labelledby="step4-heading">
        {FOLDER_DEFINITIONS.map((folder) => {
          const checked = enabledFolders[folder.key];
          const size = sizes[folder.key];
          const inputId = `step4-folder-${folder.key}`;
          return (
            <li key={folder.key} className="step4__row">
              <input
                id={inputId}
                type="checkbox"
                className="step4__checkbox"
                checked={checked}
                onChange={() => handleToggleFolder(folder.key)}
                data-testid={`step4-folder-${folder.key}`}
              />
              <label htmlFor={inputId} className="step4__row-label">
                <span className="step4__row-name">
                  <code>{folder.label}</code>
                </span>
                <span className="step4__row-desc">{folder.description}</span>
              </label>
              <span
                className="step4__row-size"
                data-testid={`step4-size-${folder.key}`}
                aria-live="polite"
              >
                {size.status === 'loading' && <span className="step4__row-size-loading">…</span>}
                {size.status === 'ok' && (
                  <>
                    <span className="step4__row-size-bytes">{formatBytes(size.bytes)}</span>
                    <span className="step4__row-size-files">
                      {size.fileCount} {size.fileCount === 1 ? 'file' : 'files'}
                    </span>
                  </>
                )}
                {size.status === 'error' && (
                  <span className="step4__row-size-error" title={size.message}>
                    n/a
                  </span>
                )}
                {size.status === 'idle' && <span className="step4__row-size-idle">—</span>}
              </span>
            </li>
          );
        })}
      </ul>

      {enabledFolders.prefs && (
        <div className="step4__init-toggle">
          <input
            id="step4-init-txt"
            type="checkbox"
            checked={initTxtMachineLocal}
            onChange={handleToggleInitTxt}
            data-testid="step4-init-txt-toggle"
          />
          <label htmlFor="step4-init-txt" className="step4__init-label">
            <span className="step4__init-name">
              Treat <code>prefs/init.txt</code> as machine-local
            </span>
            <span className="step4__init-desc">
              Resolution, render mode, and window settings differ across PCs. When on, this file is
              excluded from sync.
            </span>
          </label>
        </div>
      )}

      {!enabledFolders.data &&
        !enabledFolders.mods &&
        !enabledFolders.prefs &&
        !enabledFolders.save && (
          <p className="wizard-step__error" role="alert" data-testid="step4-no-folders">
            Pick at least one folder to sync.
          </p>
        )}
    </section>
  );
}
