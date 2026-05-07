/**
 * Wizard reducer + state types.
 *
 * The setup wizard is seven steps. Phase 7 implemented the shell and the
 * first three steps; Phase 8 fills in 4-7 and the Finish commit.
 *
 * Nothing here is persisted yet — the draft lives in renderer memory
 * until the Finish action in Step 7 calls `api.config.save(...)`.
 */
import type { AppConfig, CloudFolderValidation } from '@shared/types';

/**
 * Default `excludeGlobs` mirrored from the main-side `ConfigStore`
 * (see §6.4 of the implementation plan). Lives here as the renderer's
 * source of truth so Step 4 can pre-populate the draft without an
 * extra IPC round-trip. Keep in sync with `DEFAULT_EXCLUDE_GLOBS` in
 * `src/main/store.ts`.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '**/*.log',
  '**/gamelog.txt',
  '**/errorlog.txt',
  '**/crashlogs/**',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/.DS_Store',
  'df-syncer-windows/**'
] as const;

/**
 * Per spec §6.4: Step 4 offers a "Treat `prefs/init.txt` as machine-local"
 * toggle that prepends/removes this glob from the user's exclude list.
 */
export const PREFS_INIT_TXT_GLOB = 'prefs/init.txt';

/** Total step count for the wizard (1..7 inclusive, zero-indexed internally). */
export const WIZARD_STEP_COUNT = 7;

/** Human-readable labels for each step indicator. */
export const WIZARD_STEP_LABELS: readonly string[] = [
  'Welcome',
  'Cloud Folder',
  'Game Folder',
  'Folder Selection',
  'Machine Identity',
  'Behavior',
  'Review'
];

/**
 * Draft snapshot of the future `AppConfig` while the wizard runs. Every
 * field is optional because the user has not yet committed; on Finish
 * (Phase 8) the draft is shallow-merged with `AppConfig` defaults via
 * `api.config.save(patch)`.
 */
export type WizardDraft = Partial<
  Pick<
    AppConfig,
    | 'cloudFolder'
    | 'gameFolder'
    | 'enabledFolders'
    | 'excludeGlobs'
    | 'machineId'
    | 'conflictPolicy'
    | 'backup'
    | 'monitor'
    | 'startWithWindows'
    | 'startMinimizedToTray'
  >
>;

/** Validation snapshot for the cloud-folder step (Step 2). */
export type CloudFolderValidationSnapshot = {
  /** The path that was validated (so we can re-render the same value). */
  path: string;
  result: CloudFolderValidation;
  /** True if the user explicitly accepted a soft-warn `reason`. */
  softWarnAccepted: boolean;
};

/**
 * Indicates how Step 3's `gameFolder` was set: auto-detected on mount or
 * manually picked by the user. Drives the badge UI.
 */
export type GameFolderSource = 'detected' | 'manual' | 'none';

/** Top-level wizard state. */
export type WizardState = {
  /** 0-based index over WIZARD_STEP_LABELS. */
  stepIndex: number;
  draft: WizardDraft;
  cloudValidation: CloudFolderValidationSnapshot | null;
  gameFolderSource: GameFolderSource;
};

/** Initial state — wizard always starts at step 0 with an empty draft. */
export const INITIAL_WIZARD_STATE: WizardState = {
  stepIndex: 0,
  draft: {},
  cloudValidation: null,
  gameFolderSource: 'none'
};

/**
 * Payload for `setStep4`: the four enabled-folder flags plus the
 * `excludeGlobs` list. Phase 8's Step 4 toggles `prefs/init.txt` into
 * and out of `excludeGlobs` based on the "treat as machine-local" flag,
 * so this payload accepts the full updated list rather than diffing.
 */
export type Step4Payload = {
  enabledFolders: NonNullable<WizardDraft['enabledFolders']>;
  excludeGlobs: string[];
};

/**
 * Payload for `setStep5`: just the user-edited machine identifier.
 */
export type Step5Payload = {
  machineId: string;
};

/**
 * Payload for `setStep6`: every behavior-related field rendered on
 * Step 6. Sent as a single payload so the reducer does one shallow
 * merge per dispatch.
 */
export type Step6Payload = {
  conflictPolicy: NonNullable<WizardDraft['conflictPolicy']>;
  backup: NonNullable<WizardDraft['backup']>;
  monitor: NonNullable<WizardDraft['monitor']>;
  startWithWindows: boolean;
  startMinimizedToTray: boolean;
};

/**
 * Reducer actions. Step-specific setters take a full payload object so
 * the reducer can perform shallow merges without the caller worrying
 * about which fields it overwrites.
 */
export type WizardAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; stepIndex: number }
  | { type: 'reset' }
  | { type: 'setStep2'; cloudFolder: string; validation: CloudFolderValidation }
  | { type: 'acceptStep2SoftWarn' }
  | { type: 'clearStep2' }
  | { type: 'setStep3'; gameFolder: string; source: GameFolderSource }
  | { type: 'setStep4'; payload: Step4Payload }
  | { type: 'setStep5'; payload: Step5Payload }
  | { type: 'setStep6'; payload: Step6Payload };

function clampStep(i: number): number {
  if (i < 0) return 0;
  if (i > WIZARD_STEP_COUNT - 1) return WIZARD_STEP_COUNT - 1;
  return i;
}

/**
 * Pure reducer. Keep deterministic — no IPC calls, no `Date.now()`, no
 * randomness. The wizard tests rely on this purity.
 */
export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'next':
      return { ...state, stepIndex: clampStep(state.stepIndex + 1) };
    case 'back':
      return { ...state, stepIndex: clampStep(state.stepIndex - 1) };
    case 'goto':
      return { ...state, stepIndex: clampStep(action.stepIndex) };
    case 'reset':
      return INITIAL_WIZARD_STATE;
    case 'setStep2':
      return {
        ...state,
        draft: { ...state.draft, cloudFolder: action.cloudFolder },
        cloudValidation: {
          path: action.cloudFolder,
          result: action.validation,
          softWarnAccepted: false
        }
      };
    case 'acceptStep2SoftWarn':
      if (!state.cloudValidation) return state;
      return {
        ...state,
        cloudValidation: { ...state.cloudValidation, softWarnAccepted: true }
      };
    case 'clearStep2': {
      const nextDraft = { ...state.draft };
      delete nextDraft.cloudFolder;
      return { ...state, draft: nextDraft, cloudValidation: null };
    }
    case 'setStep3':
      return {
        ...state,
        draft: { ...state.draft, gameFolder: action.gameFolder },
        gameFolderSource: action.source
      };
    case 'setStep4':
      return {
        ...state,
        draft: {
          ...state.draft,
          enabledFolders: action.payload.enabledFolders,
          excludeGlobs: action.payload.excludeGlobs
        }
      };
    case 'setStep5':
      return {
        ...state,
        draft: { ...state.draft, machineId: action.payload.machineId }
      };
    case 'setStep6':
      return {
        ...state,
        draft: {
          ...state.draft,
          conflictPolicy: action.payload.conflictPolicy,
          backup: action.payload.backup,
          monitor: action.payload.monitor,
          startWithWindows: action.payload.startWithWindows,
          startMinimizedToTray: action.payload.startMinimizedToTray
        }
      };
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

/** Regex used by Step 5 to validate `machineId`. 1-32 chars, alnum + .-_ */
export const MACHINE_ID_REGEX = /^[A-Za-z0-9._-]+$/;

/** Returns true if `id` passes the Step 5 validation rules. */
export function isValidMachineId(id: string | undefined): boolean {
  if (!id) return false;
  if (id.length < 1 || id.length > 32) return false;
  return MACHINE_ID_REGEX.test(id);
}

/**
 * Returns true when the user is allowed to advance from the current step.
 *
 * Step gates:
 *  - Step 1 (welcome): always.
 *  - Step 2 (cloud): clean validation, soft-warn acknowledged.
 *  - Step 3 (game folder): non-empty path.
 *  - Step 4 (folder selection): at least one folder enabled.
 *  - Step 5 (machine id): valid machine id.
 *  - Step 6 (behavior): always (every field has a sensible default).
 *  - Step 7 (review): always (Finish is the gated action there).
 */
export function canAdvance(state: WizardState): boolean {
  switch (state.stepIndex) {
    case 0:
      return true;
    case 1: {
      const v = state.cloudValidation;
      if (!v) return false;
      if (!v.result.ok) return false;
      if (v.result.reason && !v.softWarnAccepted) return false;
      return true;
    }
    case 2:
      return Boolean(state.draft.gameFolder && state.draft.gameFolder.length > 0);
    case 3: {
      const ef = state.draft.enabledFolders;
      if (!ef) return true; // Defaults are applied on mount; allow advancing.
      return Boolean(ef.data || ef.mods || ef.prefs || ef.save);
    }
    case 4:
      return isValidMachineId(state.draft.machineId);
    case 5:
      return true;
    case 6:
      return true;
    default:
      return true;
  }
}
