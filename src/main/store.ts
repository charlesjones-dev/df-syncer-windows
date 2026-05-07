import os from 'node:os';
import { EventEmitter } from 'node:events';
import Store from 'electron-store';
import type { AppConfig } from '@shared/types';

/**
 * Default `excludeGlobs` per §6.4 of the implementation plan.
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
];

/**
 * Build a fresh `AppConfig` populated with documented defaults.
 *
 * Exported for tests and for the seeding path inside `createConfigStore`.
 */
export function buildDefaultConfig(): AppConfig {
  return {
    schemaVersion: 1,
    cloudFolder: '',
    gameFolder: '',
    enabledFolders: {
      data: false,
      mods: true,
      prefs: true,
      save: true
    },
    excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
    machineId: safeHostname(),
    conflictPolicy: 'newer-wins-backup',
    backup: {
      keepLastN: 10,
      compress: true
    },
    monitor: {
      enabled: true,
      onGameStart: 'prompt-pull',
      onGameExit: 'prompt-push',
      pollIntervalMs: 3000
    },
    startWithWindows: false,
    startMinimizedToTray: false,
    firstRunCompleted: false
  };
}

function safeHostname(): string {
  try {
    return os.hostname() || 'this-pc';
  } catch {
    return 'this-pc';
  }
}

/**
 * Options passed when constructing a config store. `cwd` is exposed so
 * Vitest can point at a temp directory; in production the field is left
 * unset and electron-store writes to `<userData>/config.json`.
 */
export type ConfigStoreOptions = {
  cwd?: string;
};

/**
 * Wrapper around `electron-store` typed against `AppConfig`.
 *
 * Lifecycle:
 * - On first construction the file may be empty; the store seeds it via
 *   `defaults` and `buildDefaultConfig()`.
 * - On read, if the persisted blob lacks `schemaVersion` (older or
 *   corrupted file), the wrapper treats the data as fresh and merges
 *   defaults on top so callers always see a complete config.
 * - `save(patch)` performs a shallow merge for top-level keys and a
 *   single-level deep merge for the nested `enabledFolders`, `backup`,
 *   and `monitor` objects so partial updates do not stomp siblings.
 */
export class ConfigStore extends EventEmitter {
  private readonly store: Store<AppConfig>;

  constructor(options: ConfigStoreOptions = {}) {
    super();
    const defaults = buildDefaultConfig();
    this.store = new Store<AppConfig>({
      name: 'config',
      defaults,
      ...(options.cwd ? { cwd: options.cwd } : {})
    });

    // Self-heal: if a stored file has no schemaVersion (corrupted or
    // pre-existing without our shape), rewrite with defaults merged on
    // top of whatever survived.
    const stored = this.store.store as Partial<AppConfig> | undefined;
    if (!stored || stored.schemaVersion !== 1) {
      this.store.store = mergeWithDefaults(stored ?? {}, defaults);
    }
  }

  /** Return the full config. Always populated. */
  get(): AppConfig {
    return this.store.store as AppConfig;
  }

  /**
   * Apply a partial update and return the resulting config. Performs a
   * shallow merge; the `enabledFolders`, `backup`, and `monitor` objects
   * are merged one level deep so callers can update individual fields.
   */
  save(patch: Partial<AppConfig>): AppConfig {
    const current = this.get();
    const next = applyPatch(current, patch);
    this.store.store = next;
    this.emit('change', next);
    return next;
  }

  /** True until `firstRunCompleted` has been set on the persisted config. */
  isFirstRun(): boolean {
    return !this.get().firstRunCompleted;
  }

  /** Path on disk; useful for tests and diagnostics. */
  get path(): string {
    return this.store.path;
  }
}

function applyPatch(current: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return {
    ...current,
    ...patch,
    enabledFolders: {
      ...current.enabledFolders,
      ...(patch.enabledFolders ?? {})
    },
    backup: {
      ...current.backup,
      ...(patch.backup ?? {})
    },
    monitor: {
      ...current.monitor,
      ...(patch.monitor ?? {})
    }
  };
}

function mergeWithDefaults(stored: Partial<AppConfig>, defaults: AppConfig): AppConfig {
  return {
    ...defaults,
    ...stored,
    schemaVersion: 1,
    enabledFolders: {
      ...defaults.enabledFolders,
      ...(stored.enabledFolders ?? {})
    },
    backup: {
      ...defaults.backup,
      ...(stored.backup ?? {})
    },
    monitor: {
      ...defaults.monitor,
      ...(stored.monitor ?? {})
    }
  };
}
