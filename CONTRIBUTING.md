# Contributing to df-syncer-windows

Thanks for your interest in contributing! Here's how to get started.

## Getting Started

1. Fork the repository.
2. Clone your fork: `git clone https://github.com/<your-username>/df-syncer-windows.git`.
3. Install dependencies: `pnpm install --frozen-lockfile`.
4. Start development mode: `pnpm run dev`.

## Scripts

| Script                   | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| `pnpm run dev`           | Start electron-vite dev server with HMR.                        |
| `pnpm run build`         | Build main / preload / renderer bundles into `out/`.            |
| `pnpm run package`       | Build a portable `.exe` into `dist/`.                           |
| `pnpm run package:installer` | Build an NSIS installer into `dist/`.                       |
| `pnpm run package:msi`   | Build an MSI installer into `dist/` (requires WiX v3).          |
| `pnpm run package:all`   | Build all three Windows artifacts into `dist/`.                 |
| `pnpm run setup:msi`     | One-time install of WiX v3 via winget on a dev machine.         |
| `pnpm run typecheck`     | `tsc --noEmit` against both tsconfigs.                          |
| `pnpm run lint`          | `eslint src/`.                                                  |
| `pnpm run lint:fix`      | `eslint src/ --fix`.                                            |
| `pnpm run format`        | Prettier write across `src/`.                                   |
| `pnpm run format:check`  | Prettier check across `src/`.                                   |
| `pnpm run check`         | Typecheck + lint + format check (the CI gate).                  |
| `pnpm run test`          | Run all Vitest suites.                                          |
| `pnpm run test:watch`    | Watch mode.                                                     |
| `pnpm run audit:deps`    | `pnpm audit` against the lockfile.                              |
| `pnpm run audit:sast`    | Run Semgrep over `src/` (requires Docker locally — not in CI).  |
| `pnpm run audit:all`     | `audit:deps` + `audit:sast` together.                           |
| `pnpm run clean`         | Remove `node_modules`, `out`, `dist`.                           |

`audit:sast` is a local-only check; CI runs only `audit:deps` to avoid the
Docker-on-Actions complexity for v1.

## Branch Convention

- `feature/<short-name>` — new functionality.
- `fix/<short-name>` — bug fixes.
- `chore/<short-name>` — refactors, deps, infra.
- `docs/<short-name>` — documentation-only changes.

## Pull Request Checklist

Before requesting review:

- [ ] `pnpm run check` is clean (typecheck + lint + format).
- [ ] `pnpm run test` is green.
- [ ] `pnpm run audit:deps` reports no new high-severity advisories.
- [ ] UI changes include a screenshot or short clip in the PR body.
- [ ] User-visible changes have a `CHANGELOG.md` entry under `[Unreleased]`.
- [ ] No new dependencies without a one-sentence justification in the PR.

## Project Structure

- `src/main/` — Electron main process (Node.js): app lifecycle, IPC handlers,
  filesystem and process work, sync engine.
- `src/main/sync/` — pure sync engine: scan, manifest, diff, atomic writes,
  backup, lock, executor.
- `src/preload/` — secure `contextBridge` API surface.
- `src/renderer/` — React UI (wizard, dashboard, settings, log viewer).
- `src/shared/` — types and IPC channel constants used by both processes.
- `tests/` — Vitest unit and fixture-based integration tests.
- `docs/plans/` — design and implementation plans.

## Reporting Bugs

Open an issue with:

- Steps to reproduce.
- Expected vs actual behavior.
- Windows version and df-syncer-windows version (Settings → About).

For security issues, see [SECURITY.md](SECURITY.md) — please do not open a
public issue.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
