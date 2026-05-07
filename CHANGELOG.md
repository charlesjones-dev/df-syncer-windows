# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-07

### Added

- Setup wizard for cloud-drive folder + Dwarf Fortress folder detection.
- Bidirectional per-folder sync with three-way diff and SHA-1 hashing.
- Newer-wins-with-backup conflict resolution; dry-run preview.
- Atomic file writes and advisory cloud lock.
- Process monitor for Dwarf Fortress with on-exit push prompt and tray notifications.
- Settings modal (General/Sync/Backup/Monitor/Excludes/About), in-app log viewer.
- Distribution as portable .exe, NSIS installer, and MSI.

[1.0.0]: https://github.com/charlesjones-dev/df-syncer-windows/releases/tag/v1.0.0