# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in df-syncer-windows, please report it
responsibly.

**Do not open a public issue for security vulnerabilities.**

Email reports to [**charlesjones.dev/contact**](https://charlesjones.dev/contact) with:

- A description of the vulnerability.
- Steps to reproduce.
- Potential impact.
- A suggested fix (if any).

## Response Window

- **Triage**: an initial response within **7 days** acknowledging the report
  and indicating whether it appears in scope.
- **Fix or disclosure**: for high-severity issues, a fix or coordinated
  disclosure within **30 days** of triage. Lower-severity issues will be
  scheduled into a normal release cadence.

## Scope

In scope:

- The application source code in this repository.
- The IPC surface between the renderer and main process.
- Filesystem operations (atomic writes, backup snapshots, manifest writes).
- Cloud-folder writes and the advisory `df-syncer-windows/lock.json` protocol.

Out of scope:

- Vulnerabilities in upstream Electron, Node.js, or Windows that we cannot
  mitigate from inside the application. We will track upstream advisories and
  bump dependencies on a normal cadence; please report those upstream.
- Issues that require already-compromised local privileges (an attacker who
  can write inside `%APPDATA%\df-syncer-windows` can already do anything df-syncer-windows can).
- Issues caused by user-supplied glob excludes that bypass intended sync
  scope — these are configuration choices, not security defects.

## Security Posture

df-syncer-windows ships with the following measures:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on the
  renderer.
- A Content Security Policy `<meta>` tag scoping `default-src` to `'self'`.
- `will-navigate` blocked; `setWindowOpenHandler` denies all window opens.
- `app:openExternal` validates against an HTTPS host allow-list.
- All filesystem and process work happens in the main process behind typed IPC
  handlers — the renderer has no direct `fs` or `child_process` access.
- DevTools are disabled in production builds.
- No telemetry. No network calls except `shell.openExternal` for documented
  help links.
- `pnpm.onlyBuiltDependencies` allow-lists which native deps may run install
  scripts (`electron`, `esbuild`).
- `.npmrc` enforces `minimum-release-age=4320` (3 days), `frozen-lockfile=true`,
  and `audit=true`.
