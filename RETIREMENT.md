# Retirement status — September 2026

df-syncer-windows is retired and unmaintained. No further maintenance, features,
bug fixes, or security updates will be provided. Independent forks are welcome
under the existing [MIT License](LICENSE). Source code, technical documentation,
the license, changelog, lockfile, tags, and releases are preserved.

## Distribution and services

The following checks were made during archival preparation in September 2026.
Repository archival does not retire external packages, listings, or services.
Nothing was unpublished, disabled, or shut down as part of this preparation.

| Surface                             | Verified status and remaining action                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Releases                     | [v1.0.0](https://github.com/charlesjones-dev/df-syncer-windows/releases/tag/v1.0.0) is published with portable EXE, NSIS installer, MSI, blockmap, and `latest.yml` assets. The release and tag are preserved unchanged as unsupported historical artifacts.                                                                                                                             |
| npm                                 | `package.json` has `private: true`. The public registry lookup for the exact name `df-syncer-windows` returned HTTP 404. This does not prove it was never published or exclude packages under other names.                                                                                                                                                                               |
| GitHub Packages                     | npm and container package enumeration could not be verified: the GitHub API returned HTTP 403 because the available credential lacks `read:packages`. The owner should inspect account packages for any associated publications and decide their retirement separately.                                                                                                                  |
| Windows stores and package managers | The repository contains EXE/MSI packaging configuration but no store listing, package identifier for winget/Chocolatey/Scoop, or publishing workflow. Exact-name searches in `microsoft/winget-pkgs` and `ScoopInstaller/Extras` returned no matches. Microsoft Store, Chocolatey, other package names, and private listings remain unverified; check any publisher accounts separately. |
| GitHub hosting                      | The repository API reports Pages disabled, zero deployments, and zero environments. The only workflow is CI; no deployment or publishing workflow is configured.                                                                                                                                                                                                                         |
| External hosting and paid services  | No project-operated backend, hosting configuration, billing integration, or funding configuration was found in the repository. Cloud-drive providers named in the docs are users' own local sync clients. External hosting accounts, subscriptions, domains, and billing cannot be verified from the repository; the owner should review any associated accounts separately.             |

## GitHub handoff

- No open issues or pull requests were present during the initial inspection.
- The owner will archive the repository after the retirement documentation is
  merged and any separate account reviews are complete. This preparation does
  not archive the repository.
- Any unfinished plans, screenshot promises, setup instructions, or references to
  future work in the preserved history are historical documentation only.
