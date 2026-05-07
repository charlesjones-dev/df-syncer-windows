# df-syncer-windows

Sync Dwarf Fortress saves, mods, and prefs across PCs via a local cloud-drive folder.

[![CI](https://github.com/charlesjones-dev/df-syncer-windows/actions/workflows/ci.yml/badge.svg)](https://github.com/charlesjones-dev/df-syncer-windows/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What it does

df-syncer-windows keeps your Dwarf Fortress (Steam Edition) data — saves, mods, prefs,
and optionally `data/installed_mods/` — in sync across multiple Windows PCs by
writing to a folder your existing cloud client (Proton Drive, OneDrive,
Dropbox, Google Drive, iCloud, etc.) is already mirroring. The app never logs
into your cloud account or talks to a cloud API; it only reads and writes the
local folder you point it at.

Sync is manual and explicit: you click Push / Pull / Full Sync and review a
diff before anything is committed. Every overwrite is preceded by a recoverable
backup, every cloud write is atomic, and a process monitor watches for the
game so it can prompt you to push when you're done playing.

## Features

- Bidirectional per-folder mirror with three-way diff (`local` × `cloud` × `last-base`).
- SHA-1-based file identity — robust to cloud clients that rewrite mtimes.
- `newer-wins-with-backup` conflict resolution by default; tied mtimes always prompt.
- Dry-run preview for every operation; nothing is written without an Apply click.
- Process monitor for `Dwarf Fortress.exe` with on-exit push prompt and tray
  notifications.
- No cloud API integration — only touches the local mirror folder. No OAuth,
  no telemetry, no network calls except `shell.openExternal` for help links.
- Distributable as portable `.exe`, NSIS installer, and `.msi`.

## Screenshots

Screenshots — coming soon.

## Install

Three artifacts are published on the [GitHub Releases](https://github.com/charlesjones-dev/df-syncer-windows/releases) page for each tagged version:

- **Portable** — `df-syncer-windows-<version>.exe`. Single file, no installation, runs anywhere.
- **Installer** — `df-syncer-windows-<version>-setup.exe`. NSIS installer with Start Menu entry.
- **MSI** — `df-syncer-windows-<version>.msi`. For Group Policy or `winget` deployment.

Windows 10 (x64) or later. The MSI artifact is for end users and does not
require any extra tooling to install — WiX v3 is only needed by the build
machine.

## Quickstart

1. Install (`df-syncer-windows-X.Y.Z-setup.exe` or run the portable `.exe`).
2. On first launch, the wizard opens.
3. Pick the local folder your cloud drive mirrors (e.g. `C:\Users\<you>\Proton Drive`).
4. Confirm the auto-detected DF folder (`%APPDATA%\Bay 12 Games\Dwarf Fortress`) or pick yours.
5. Tick which subfolders to sync (default: `save` / `mods` / `prefs`).
6. Name this PC (used in manifest, lock, and backup paths).
7. Review and run a dry-run preview.
8. Finish. Click **Push** to seed the cloud. On your other PC, install df-syncer-windows,
   point at the same cloud folder, click **Pull**.

## How sync works

df-syncer-windows keeps a per-folder mirror under `<cloudFolder>/df-syncer-windows/`. On each
sync, it scans the local folder, scans the cloud mirror, and three-way-diffs
both against the last manifest this PC saw. Identity is content-addressed
(streaming SHA-1) so cloud clients that rewrite `mtime` after upload don't
confuse it. The default conflict policy picks the side with the newer `mtime`
and copies the loser into a local backup snapshot first; ties within 2 seconds
always prompt. Cloud writes are atomic (`<file>.df-syncer-windows.tmp` then rename), and
an advisory `df-syncer-windows/lock.json` keeps two PCs from syncing simultaneously.

## Troubleshooting

### Cloud client rewrites mtimes

Some cloud clients overwrite `mtime` on upload. df-syncer-windows hashes file contents
(SHA-1) and treats `mtime` as a hint only — files that hash identical are
treated as unchanged regardless of `mtime` skew.

### Conflict-tie behavior

When the same file is modified on both sides within 2 seconds, df-syncer-windows treats
it as a tie and prompts you regardless of the configured conflict policy.
Tied mtimes typically mean two PCs ran auto-save at the same moment.

### Stale lock from a crashed sync

A crashed or force-quit sync may leave `<cloudFolder>/df-syncer-windows/lock.json`
behind. df-syncer-windows auto-clears the lock if it's older than 10 minutes **and**
the lock owner's `machineId` matches this PC. A foreign stale lock is
preserved and surfaced in the UI so you can decide.

### MSI install fails to build

The `.msi` build target requires WiX v3 on the build machine. Run
`pnpm run setup:msi` once on a new dev box to install it via winget. End users
installing the published `.msi` artifact do not need WiX.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, scripts, branch convention,
and the PR checklist.

## License

[MIT](LICENSE) — Copyright (c) 2026 Charles Jones.
