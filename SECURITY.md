# Security Policy

## End of security support — September 2026

This project is retired and unmaintained. **No versions are supported**, including
v1.0.0. There will be no security updates, dependency updates, vulnerability
triage, or coordinated disclosure from this project.

The former private reporting channel and response windows are retired. Do not
submit vulnerability reports here expecting a response or fix. For an independent
fork, follow its security policy; for an upstream dependency, use that upstream
project's reporting process. See [SUPPORT.md](SUPPORT.md).

## Historical security scope

The former policy covered:

- The application source code in this repository.
- The IPC surface between the renderer and main process.
- Filesystem operations (atomic writes, backup snapshots, manifest writes).
- Cloud-folder writes and the advisory `df-syncer-windows/lock.json` protocol.

The former policy excluded:

- Vulnerabilities in upstream Electron, Node.js, or Windows that could not be
  mitigated from inside the application. Upstream advisories are no longer
  monitored and dependencies will not be updated here.
- Issues that require already-compromised local privileges (an attacker who
  can write inside `%APPDATA%\df-syncer-windows` can already do anything df-syncer-windows can).
- Issues caused by user-supplied glob excludes that bypass intended sync
  scope — these are configuration choices, not security defects.

## Historical security posture

The retired code includes the following measures. This is technical reference,
not an assurance of ongoing security or support:

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
