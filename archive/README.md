# Retired Crawler implementations (R41)

This directory is for historical source only. Nothing in `archive/` participates in the active pnpm
workspace, builds, type checks, lint, dependency checks, duplication checks, unit tests, CI or deployment.
Do not run or deploy archived package scripts, launchers or manifests. The current services are
`apps/api`, `apps/worker` and the live Windows OCR API in `apps/ocr-service`; see
[the architecture](../docs/architecture/ARCHITECTURE.md) and [manual deployment](../ops/deploy/README.md).
The owner decided there is no CLI and no web service. Historical documentation remains historical.

## Directory move status

**The moves are pending, not completed.** On 2026-09-30 the first `git mv` failed because this session
cannot write `.git/index.lock` (`Operation not permitted`). No source directory was moved or deleted;
at present this archive contains this README and empty destination directories. The active workspace
uses an explicit allowlist, so the old folders are excluded even while they remain at their original
locations. No commit, branch, install, server action or network request was made for R41.

Once Git index writes are available, these are the exact pending moves (run from the repository root):

```sh
mkdir -p archive/apps archive/packages
git mv apps/backend archive/apps/backend
git mv apps/browser-node archive/apps/browser-node
git mv apps/cli archive/apps/cli
git mv apps/v3-api archive/apps/v3-api
git mv apps/v3-confirmations archive/apps/v3-confirmations
git mv apps/v3-pilot archive/apps/v3-pilot
git mv apps/v3-workers archive/apps/v3-workers
git mv apps/web archive/apps/web
git mv packages/contracts archive/packages/contracts
git mv packages/ocr-client archive/packages/ocr-client
git mv packages/runtime archive/packages/runtime
git mv packages/v3-acquisition archive/packages/v3-acquisition
git mv packages/v3-channels archive/packages/v3-channels
git mv packages/v3-ocr archive/packages/v3-ocr
git mv packages/v3-pdf archive/packages/v3-pdf
git mv packages/v3-review archive/packages/v3-review
git mv packages/v3-text archive/packages/v3-text
```

The first eight folders contain the replaced controller, browser host, CLI, V3 hosts/pilot/confirmation
service and web UI. The next three are the pre-V3 contracts, OCR client and runtime, used only by old
apps. The last six are V3 implementations superseded by the new layered packages (PDF is retired).
All package-local tests, fixtures, build files and deployment helpers move with their folder.

## Kept manifest dependency closure

Computed recursively from `dependencies`, `devDependencies`, `optionalDependencies` and
`peerDependencies` in local `package.json` files, starting at `v3-product` and `v3-contracts`.
The table lists workspace edges; external npm dependencies remain declared in those manifests.

| Kept folder | Direct workspace dependencies |
| --- | --- |
| `packages/v3-product` | `v3-contracts`, `v3-vision`, `v3-artifacts` |
| `packages/v3-contracts` | None |
| `packages/v3-vision` | `v3-contracts`, `v3-codex`, `v3-artifacts`, `v3-results`, `v3-worker-runtime` |
| `packages/v3-artifacts` | `platform`, `v3-contracts` |
| `packages/v3-results` | `v3-contracts`, `v3-artifacts` |
| `packages/v3-codex` | `v3-contracts` |
| `packages/v3-worker-runtime` | None |
| `packages/platform` | `v3-contracts` |

The `v3-product` directory and all its dependency declarations are preserved. Its only active export,
build entry and type-check/test roots are `src/resource-workflow.ts` and its unit test, needed by
`packages/workflows/src/resources/versioned-gate.ts` and `testing/legacy-gate.ts` for histories started
before `resource-gate-v1`. Its old product entry points and business tests are inactive: they import
retired packages through undeclared relative paths. No gate implementation or workflow history was
changed. The old `v3-results/integration` test depends on the retired V3 API database fixture and is
excluded from the active type-check roots; integration tests are already outside the root unit suite.

Also preserved in place: `apps/{api,worker,ocr-service}`, `ops/`, `database/`,
`packages/{adapters,app,workflows,processing,platform,channels/*}` and `crawl-products`.
The OCR service is Python, has no pnpm manifest, and is the live Windows OCR API.

## Compatibility tests

These tests are excluded now and will move with their whole package when the pending moves execute:

- `packages/v3-acquisition/src/compatibility/file-download.test.ts`
- `packages/v3-acquisition/src/compatibility/file-module.test.ts` (and `file-fixture.ts`)
- `packages/v3-channels/src/compatibility/http-capture.test.ts`
- `packages/v3-channels/src/compatibility/swanson-static-html.test.ts`
- `packages/v3-ocr/src/compatibility.test.ts`

`v3-artifacts` is **kept by the required dependency closure**, so its compatibility tests stay in place
and remain in the unit suite: `file-copies-compatibility`, `integrity-compatibility`,
`publication-compatibility`, `r2-compatibility` and `resolver-compatibility` (all `.test.ts` under
`packages/v3-artifacts/src/compatibility/`). This package is not part of the archive moves.

## Dependency refresh and verification

The dependency install was explicitly forbidden for this session and has not run. After moving the
folders, refresh workspace links and regenerate the lockfile with:

```sh
pnpm install --no-frozen-lockfile
```

Review the resulting lockfile changes before committing. CI continues to use
`pnpm install --frozen-lockfile`; the existing lockfile still contains retired workspace importers
until the refresh. No hand-edited lockfile or temporary workspace links substitute for installation.
Local checks use `npx --offline --no-install` to forbid package downloads.

Verification on 2026-09-30 (a snapshot while another agent was actively wiring DTC):

| Check | Result |
| --- | --- |
| `npx --offline --no-install tsc --noEmit --project <kept-package>/tsconfig.json` | 19 of 21 packages passed. API and Worker could not resolve the newly imported `@crawl-automation/channel-dtc`; workspace links have not been refreshed. |
| `npx --offline --no-install vitest run --config vitest.v3.config.ts` | 247 files passed, 21 failed; 2,225 tests passed, 1 failed, 97 skipped. Ten failed files could not resolve DTC, seven could not start sandboxed Temporal servers, three could not allocate PostgreSQL shared memory, and the DTC capture test called `.catch` on an undefined mock result. These failures were not hidden by exclusions. |
| Legacy gate tests | All 41 tests in `resource-workflow.test.ts` passed. |
| Kept artifact compatibility tests | All five files passed (77 tests). |
| ESLint on changed JS/TS configurations; Node syntax checks; changed JSON parsing | Passed. |
| Dependency-cruiser and syncpack | Passed: zero errors/warnings, only the two existing legacy-gate baseline exemptions. None of the 17 retired folders was scanned. |
| Turbo build and type-check dry runs | Passed; no retired package task appears in either plan. Full builds were not run. |
| TypeScript project references | No `references` arrays in the repository's 38 tsconfig files. Active include roots do not traverse retired code. |
| Preservation | All 1,168 tracked files in the 17 pending-move folders matched their pre-move SHA-256 values; zero tracked deletions. |

The protected DTC/API/Worker/workflow/contract source files were not edited by this task. Re-run the
checks after the other agent finishes and the authorized dependency refresh has been performed;
Temporal/PostgreSQL tests also need an execution environment that permits their local servers.

## Owner decisions and possible later deletion

- `tools/brand-certifications` and `tools/dtc-ego-bridge` remain untouched. Their long-term retention
  or migration is an owner decision; neither is added to workspace execution or CI.
- No files were deleted. The 17 retired folders above could eventually be deleted after the owner
  accepts their archive and retention needs; this ticket only calls for moving them.
- Obsolete root deployment files (`Dockerfile`, `compose.mac.yml`, `railway.toml`, `deploy.sh`,
  `start-control-plane.sh`, `start-workers.sh`, `start-workers-cloud.sh`) still describe the retired
  services. They are outside the new `ops/deploy` path and must not be used. Their separate removal
  or archival, plus old launch scripts under `scripts/mac`, is left for the owner; none was executed.
- `.dependency-cruiser.old-packages.cjs` is an existing untracked, obsolete allowlist. The active
  configuration does not load it; it is a deletion candidate, not something this task removed.
- Stale `node_modules`, `dist` and build caches for retired packages are possible cleanup candidates
  after installation. They were not deleted. The legacy gate and its dependency closure cannot be
  deleted until the pre-`resource-gate-v1` histories no longer require them.
- Saved evidence, databases, workflow histories and existing unrelated changes remain untouched.
