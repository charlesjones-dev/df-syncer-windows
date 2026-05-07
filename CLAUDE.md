# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Electron desktop app (Windows-only, x64) that syncs Dwarf Fortress saves/mods/prefs across PCs by reading and writing a folder the user's existing cloud client (Proton Drive, OneDrive, etc.) is already mirroring. The app never authenticates with any cloud provider — it only touches the local mirror folder. Sync is manual and explicit (Push / Pull / Full Sync) and every overwrite is preceded by a recoverable backup.

Package manager is **pnpm** (enforced via `frozen-lockfile=true` in `.npmrc`). The `.npmrc` also pins `minimum-release-age=4320` (3 days) for supply-chain safety; new dependencies won't install until they've been published for that long.

## Common commands

```
pnpm install --frozen-lockfile  # bootstrap
pnpm run dev                    # electron-vite dev server with HMR
pnpm run build                  # build main / preload / renderer into out/
pnpm run check                  # typecheck + lint + format check (the CI gate)
pnpm run typecheck              # tsc --noEmit against tsconfig.node.json + tsconfig.web.json
pnpm run lint                   # eslint src/
pnpm run lint:fix               # eslint src/ --fix
pnpm run format                 # prettier --write
pnpm run test                   # vitest run --passWithNoTests
pnpm run test:watch             # watch mode
pnpm run audit:deps             # pnpm audit --audit-level=critical
pnpm run audit:sast             # local-only Semgrep via Docker (NOT in CI)
pnpm run package:all            # portable .exe + NSIS setup + .msi (requires WiX v3)
pnpm run setup:msi              # one-time WiX v3 install via winget (build machine only)
pnpm run clean                  # rimraf node_modules out dist
```

Run a single Vitest file: `pnpm exec vitest run tests/sync/diff.test.ts`. Run a single test by name: `pnpm exec vitest run -t "tie threshold"`.

CI (`.github/workflows/ci.yml`) runs on `windows-latest` and executes `pnpm run check`, `pnpm run test`, `pnpm run audit:deps` — match these locally before pushing. Vitest timeouts are bumped to 15s in `vitest.config.ts` because Defender on Windows CI briefly holds file handles during temp-dir cleanup.

## Architecture

This is a three-process Electron app following the modern security defaults: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer has no Node access; everything goes through a typed IPC bridge.

### Process layout

- **`src/main/`** — Node.js main process. Owns the app lifecycle, IPC handlers, filesystem and process work, sync engine, persisted config, logger, tray, and process monitor. `index.ts` is the entry point and orchestrates all of it (single-instance lock, window creation, store/monitor/tray wiring, IPC registration, app menu, navigation hardening).
- **`src/preload/index.ts`** — the only bridge. Uses `contextBridge.exposeInMainWorld('df', ...)` to expose a typed wrapper over `ipcRenderer.invoke`. Returns raw `Result<T>` envelopes; the renderer unwraps them.
- **`src/renderer/`** — React 18 UI (wizard, dashboard, settings modal, log viewer). Calls go through `src/renderer/api.ts`, which unwraps `Result<T>` → throws on `ok: false` so call sites can `await` data directly.
- **`src/shared/`** — types and IPC channel constants imported by both processes. **All IPC channel names live in `src/shared/ipc-channels.ts` as the `IPC` const** — never hardcode channel strings; import from there. **All cross-process types live in `src/shared/types.ts`** — extending the IPC surface means editing `IpcApi` there, then the preload bridge, then the renderer wrapper.

The Vite alias `@shared` resolves to `src/shared` from all three build entries (configured in `electron.vite.config.ts` and mirrored in `vitest.config.ts`).

### Sync engine (`src/main/sync/`)

The sync engine is **pure where possible** and composed end-to-end by `applyPlan` in `execute.ts`. The state machine is documented at the top of `execute.ts`; read it before changing anything in this directory.

- `scan.ts` — walk a folder, return `FileEntry[]` with streaming SHA-1 hashes. Identity is content-addressed; mtime is consulted only as a tiebreaker.
- `manifest.ts` — atomic read/write of cloud manifest (`<cloudFolder>/df-syncer-windows/manifest.json`) and local "last-base" manifest (`<userDataDir>/manifests/last-cloud.json`). Zod-validated; raises `ManifestSchemaVersionError` on version mismatch.
- `diff.ts` — pure three-way diff (`local × cloud × base`). No `fs`, no `Date.now()` unless overridden via `opts.clock`. Conservative when `base === null` (everything different becomes `conflict-tie`). Tie threshold for mtimes is 2 seconds.
- `diff-applier.ts` — applies the configured `ConflictPolicy` to a raw diff, producing a materialized plan plus any user-facing prompts.
- `atomic.ts` — `<file>.df-syncer-windows.tmp` → `fsync` → rename. Retries `EPERM` from Defender / cloud client / Explorer preview holding handles. **All destructive cloud writes go through these primitives.**
- `backup.ts` — session-scoped backup; every overwrite is captured before being applied. Finalised on every code path past `backup-begin` (even on error or abort) so displaced bytes are recoverable.
- `lock.ts` — advisory `<cloudFolder>/df-syncer-windows/lock.json`. Auto-clears stale locks (>10 min) **only when** `machineId` matches this PC; foreign stale locks surface in the UI.
- `execute.ts` — composes the above. Owns the executor state machine: `idle → pre-check → lock → backup-begin → apply → manifest-rebuild → manifest-write → backup-finalize → prune → history-write → done`. Invariants: lock is always released; backup is always finalised; **on any error after `backup-begin`, manifests are NOT written** (so re-running on a fresh plan recovers user intent); idempotent (re-running a clean plan is a no-op).

### Other main-process modules

- `store.ts` — `electron-store`-backed `ConfigStore` with `EventEmitter` change notifications. Defaults are documented inline; `DEFAULT_EXCLUDE_GLOBS` is mirrored in `src/renderer/state/store.ts` (keep them in sync).
- `paths.ts` — DF folder detection (APPDATA → Steam library scan via `reg query` + `libraryfolders.vdf`). Cloud-folder validation. Recursive size estimation.
- `process-monitor.ts` — polls `tasklist.exe` (NOT `ps-list`, which has an asar-vendoring bug). Detects `Dwarf Fortress.exe` by basename. Emits `Idle → Running` immediately with `prompt: 'on-start'`; `Running → Idle` immediately, then a second event with `prompt: 'on-exit'` after a cooldown (15s default, 5s when policy is `auto-push`). The executor calls `pause()`/`resume()` around `applyPlan` to suppress flicker.
- `ipc.ts` — registers all IPC handlers; returns a single `unregister` function that `app.on('will-quit')` uses for cleanup.
- `tray.ts` — system tray with sync actions and on-start/on-exit notification policies. Requires `app.setAppUserModelId(APP_USER_MODEL_ID)` for `Notification` action buttons to render on Windows.
- `logger.ts` — file-backed structured logger under `<userDataDir>/logs/`. Tail subscriptions via `logs:tail` / `logs:tail:line` IPC.
- `menu.ts` — application menu with `Ctrl+,` (Settings), `Ctrl+L` (Logs), `Ctrl+Q` (Quit) accelerators and a Sync submenu. `autoHideMenuBar` outside dev mode but accelerators stay live.

### Renderer

- `state/store.ts` — wizard reducer (7 steps). The wizard draft lives in renderer memory until Step 7's Finish action calls `api.config.save(...)`.
- `components/wizard/` — Steps 1-7 + `WizardShell.tsx`.
- `components/main/` — `Dashboard`, `DiffTable`, `SyncControls`, `HistoryPanel`, `LogViewer`, `SettingsModal`, `ProcessStatusBadge`, `Header`.
- `components/shared/` — `FolderPicker`, `Toast`.
- DevTools are blocked in packaged builds (`devtools-opened` listener + `Ctrl+Shift+I/J/C` and `F12` blocking in `before-input-event`); they work normally in dev.
- Navigation is hardened: `will-navigate` is preventDefault'd everywhere, `setWindowOpenHandler` denies all popups, and only `https://` URLs are allowed through `shell.openExternal`.

### IPC contract

Every IPC handler returns `Result<T, E = string>` (`{ ok: true, data } | { ok: false, error }`). Errors are typed and don't throw across the boundary. The preload passes envelopes through; `src/renderer/api.ts` unwraps and throws on `ok: false`. When adding a new IPC route:

1. Add the channel constant to `src/shared/ipc-channels.ts` (`<namespace>:<verb>` naming).
2. Add the type to `IpcApi` in `src/shared/types.ts`.
3. Register the handler in `src/main/ipc.ts`.
4. Expose it through `src/preload/index.ts`.
5. Add the unwrapping wrapper in `src/renderer/api.ts`.

Some `IpcApi` namespaces have stub wrappers in the renderer that throw "not implemented yet" — that's intentional for in-progress phases, not a bug.

## Tests

Vitest. Most tests run in Node; renderer tests under `tests/renderer/**` run in `jsdom` via `environmentMatchGlobs` in `vitest.config.ts` (rather than per-file `// @vitest-environment` directives — convention is centralised). Layout mirrors `src/`: `tests/main/`, `tests/sync/`, `tests/renderer/`.

## Conventions

- Prettier config: `semi: true`, `singleQuote: true`, `trailingComma: 'none'`, `printWidth: 100`, `tabWidth: 2`. EditorConfig enforces LF line endings.
- Branch names: `feature/<short>`, `fix/<short>`, `chore/<short>`, `docs/<short>`.
- PR checklist (from `CONTRIBUTING.md`): `pnpm run check` clean, `pnpm run test` green, no new high-severity advisories, screenshots for UI changes, `CHANGELOG.md` `[Unreleased]` entry for user-visible changes, one-sentence justification for any new dependency.
- Atomic-write convention: every cloud-side write uses the `*.df-syncer-windows.tmp` sidecar pattern. Don't introduce a second temp suffix.

## Development Principles

Follow these principles in all code changes:

### SOLID

- **Single Responsibility**: Each module under `src/main/sync/` does one job (scan, manifest IO, diff, backup, lock, atomic, executor). Don't bolt unrelated logic into them.
- **Open/Closed**: Extend behavior by adding new sync primitives, IPC handlers, or wizard steps; don't modify the executor state machine in `execute.ts` to special-case a feature.
- **Interface Segregation**: Keep the `IpcApi` namespaces in `src/shared/types.ts` narrow. Don't bundle unrelated calls into one namespace just because they share a caller.
- **Dependency Inversion**: Pure modules (`diff.ts`, `manifest.ts` schemas) take dependencies as injectable params (e.g. `opts.clock`). The executor depends on these primitives, not the other way around.

### DRY / Code Reuse

- Cross-process types and IPC channel names live in `src/shared/` (`types.ts`, `ipc-channels.ts`). Import via the `@shared/*` alias — never hardcode channel strings or redeclare shared types.
- Zod schemas in `src/main/sync/manifest.ts` are the source of truth for manifest shapes. Keep `FileEntry` / `Manifest` in `src/shared/types.ts` aligned with them; don't redefine ad-hoc shapes elsewhere.
- `DEFAULT_EXCLUDE_GLOBS` is intentionally duplicated across `src/main/store.ts` and `src/renderer/state/store.ts` to avoid an IPC round-trip for the wizard. Keep both arrays in sync — if you change one, change the other in the same commit.

### KISS / Simplicity

- Prefer the simplest correct solution. The sync engine uses plain functions and `EventEmitter`, not a framework — keep it that way.
- Prefer concrete types over complex generics unless the generic gives real reuse. `Result<T, E = string>` is the only generic envelope worth having.
- Three similar lines of code is better than a premature abstraction.

### YAGNI / Scope Discipline

- Build only what the current task requests. Speculative IPC namespaces or sync features stay out of `IpcApi` until a phase actually needs them.
- Recommending additional features is fine; always ask before implementing them.
- Don't add config knobs without a concrete user-visible reason. `AppConfig` in `src/shared/types.ts` is the persisted contract — every field costs a migration story.

### Modularity & Process Boundaries

- Dependency direction is **one-way**: `src/renderer/` and `src/preload/` never import from `src/main/`. Both sides may import from `src/shared/`. The renderer talks to main only through the preload bridge — no `require('electron')` in renderer code.
- The sync engine in `src/main/sync/` is **pure where the file says so**. `diff.ts` must stay free of `fs`, `process`, and uninjected `Date.now()`. Same input → same output.
- Cross-cutting changes (new IPC route, new shared type) update `src/shared/` first, then the preload bridge, then both sides. No exceptions.

### Component Architecture (renderer)

- React components must not import from sibling components. If two components need the same logic, extract it into a hook or a module under `src/renderer/components/shared/` and have both import from there.
- Components are leaf nodes in the dependency graph. They consume data from `state/store.ts` (wizard) or `api.ts` (IPC) and emit events upward; they do not orchestrate other components.
- Wizard step components (`Step1Welcome.tsx` … `Step7ReviewAndDryRun.tsx`) communicate only through the wizard reducer in `src/renderer/state/store.ts` — never by importing each other.
- Heavy reactive state (sync progress, log tail) goes through `api.ts` subscriptions. Don't introduce Redux/Zustand/etc. for ephemeral UI state — `useState`/`useReducer` is sufficient and matches existing patterns.

### Type Safety

- Keep `strict: true` plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch` in both `tsconfig.node.json` and `tsconfig.web.json`. Never weaken strict checks to silence an error — fix the type.
- Never use `any`. Use `unknown` with type guards, discriminated unions, or proper generics. The codebase has zero `any` today; keep it that way.
- Derive types from Zod schemas with `z.infer<typeof Schema>` so runtime validation and types stay locked together. Don't write a manifest type by hand and a parallel schema separately.
- IPC contracts live in `IpcApi` in `src/shared/types.ts`. The preload bridge, the renderer wrapper in `api.ts`, and the main-side handler in `ipc.ts` must all agree with that single declaration.

### Error Handling

- Every IPC handler returns `Result<T, E = string>`. Errors are typed and **must not throw across the IPC boundary**. The renderer's `api.ts` is the only place that unwraps and rethrows.
- Categorise sync failures with `SyncResultErrorKind`. Adding a new failure mode means adding a discriminator value, not a stringly-typed error.
- The executor invariants are non-negotiable: lock is always released, backup is always finalised, **manifests are never written after a post-`backup-begin` error**. New code in `execute.ts` must preserve these in `try`/`finally` blocks.
- Defensive `try/catch` around logger calls (see `src/main/index.ts`) is intentional — logger I/O must never fault the monitor or executor wiring. Match this pattern when adding new background callbacks.
- Never use empty catch blocks. At minimum, log via the structured logger with a meaningful field map. Inline `// Ignore — best-effort.` comments are acceptable only for clearly idempotent cleanup paths.

### Testing Philosophy

- Test behavior, not implementation. The pure modules (`diff.ts`, `manifest.ts`, `scan.ts`) are tested by feeding fixtures and asserting outputs — don't introduce mocks where a fixture would do.
- Most tests run in Node; only `tests/renderer/**` runs in jsdom (via `environmentMatchGlobs` in `vitest.config.ts`). Don't add per-file `// @vitest-environment` directives — extend the matcher instead.
- Prefer integration-style fixture tests (real temp dirs, real fs) for sync primitives over heavy mocking. Vitest hook/test timeouts are 15s to absorb Defender flakiness on Windows.
- Every bug fix lands with a regression test. Pure modules accept injectables (e.g. `opts.clock` in `diff.ts`) so tests can pin nondeterministic inputs — use them.
- Keep `tests/` mirroring `src/` (e.g. `tests/sync/diff.test.ts` ↔ `src/main/sync/diff.ts`).

### Git

- Never commit, amend, or push without an explicit user instruction. Completing a task, fixing a lint error, or passing CI is **not** a trigger to commit. Wait for "commit", "push", or equivalent.
- Before every commit, review `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and `CHANGELOG.md` for drift. New IPC routes, sync primitives, scripts, or settings should be reflected. User-visible changes need a `[Unreleased]` entry in `CHANGELOG.md`.
- Follow the branch convention from `CONTRIBUTING.md`: `feature/<short>`, `fix/<short>`, `chore/<short>`, `docs/<short>`.
- The CI gate is `pnpm run check && pnpm run test && pnpm run audit:deps`. Run it locally before requesting review. Never use `--no-verify` to bypass anything (there are no commit hooks today; if any are added, the same rule applies).
