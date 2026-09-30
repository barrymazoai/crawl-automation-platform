# R01 legacy import migration

Source migration completed on `main`; no commit, branch, install, package manifest edit, lockfile edit, or file deletion. Existing unrelated working-tree changes were left untouched. No deployment or live provider test was run.

The empty-baseline probe reported 14 violations (12 to migrate, two intentional resource-gate imports). The final dependency check passes with exactly those two intentional entries.

## Moves and changed files

- `apps/api/src/evidence-readers.ts`: uses the Swanson/GNC packages' label-core readers with the existing processing `TextEvidence`. Channel-specific extraction stays outside processing.
- `apps/worker/src/container.ts` and `core-parts.ts`: use platform `LocalObjectStore` directly (the old `TextLocalStore` was its alias), and channels/core file services/types.
- `apps/worker/src/label/label-stores.ts`: reads file evidence and IDs from channels/core.
- `packages/channels/core/src/pipeline/product-files.ts`: uses the new downloader. Its public pipeline behavior is unchanged.
- `packages/channels/core/src/planning/plan-codec.ts`: re-exports the file policy fingerprint and image ID from their new implementation so planning and execution share one definition.
- `packages/channels/core/src/index.ts`: exports file acquisition.
- `packages/channels/swanson/src/testing/pipeline-fixture.ts`: offline fixture built through the current projection and planning APIs, using the existing Swanson-owned saved projection. No newly captured data.
- `packages/channels/swanson/src/index.ts`: exports the fixture and static parser for tests in other packages.
- `packages/app/src/pipeline/label-tasks.test.ts`, `pipeline-services.test.ts`, and `packages/workflows/src/product-pipeline-workflow.test.ts`: use that new fixture.
- Swanson parity cases moved from `packages/channels/swanson/src/{http-capture,swanson-static-html}.test.ts` into `packages/v3-channels/src/compatibility/` with the same filenames. The original test files retain their current-implementation tests. Archive compatibility now checks both writing directions.
- `.dependency-cruiser-known-violations.json`: only the two gate entries remain. `.dependency-cruiser.cjs`: updated the baseline comment; the rule itself is unchanged.

File acquisition moved from the legacy `file.ts`, `network.ts`, `media.ts`, and relevant parts of `handoff.ts` into channels/core. The old implementations remain for existing consumers and compatibility comparisons. New files:

- `packages/channels/core/src/files/abortable.ts`
- `packages/channels/core/src/files/acquire-file-module.ts`
- `packages/channels/core/src/files/acquire-file.ts`
- `packages/channels/core/src/files/file-body.ts`
- `packages/channels/core/src/files/file-download.ts`
- `packages/channels/core/src/files/file-errors.ts`
- `packages/channels/core/src/files/file-evidence.ts`
- `packages/channels/core/src/files/file-intent.ts`
- `packages/channels/core/src/files/file-media.ts`
- `packages/channels/core/src/files/file-network.ts`
- `packages/channels/core/src/files/file-policy.ts`
- `packages/channels/core/src/files/file-ports.ts`
- `packages/channels/core/src/files/file-review.ts`
- `packages/channels/core/src/files/file-session.ts`
- `packages/channels/core/src/files/https-transport.ts`
- `packages/channels/core/src/files/index.ts`

New acquisition compatibility files, all under the old package:

- `packages/v3-acquisition/src/compatibility/file-fixture.ts`
- `packages/v3-acquisition/src/compatibility/file-download.test.ts`
- `packages/v3-acquisition/src/compatibility/file-module.test.ts`

The acquisition comparison checks exact returned artifacts, R2/local object keys and bytes, hashes, policy fingerprints, completion/intent JSON, passive Review records, storage I/O, download count, and lease/response cleanup. Scenarios include redirects, refused/invalid/truncated content, lost PUT acknowledgements, fresh-worker replay, corrupt evidence, cancellation, timeout, and no retry after failure. Random UUIDs and timestamps are fixed for byte comparisons. Registered errors retain causes; recovery catches are recorded rather than discarded.

No file deletion is needed for this ticket. Legacy implementations and the non-parity Swanson tests remain.

## Required package.json changes (not applied)

All names below have the `@crawl-automation/` prefix unless they are external libraries. Workspace dependencies use `workspace:*`.

| Package path | Remove | Add |
| --- | --- | --- |
| `apps/api` | dependencies: `v3-text`, unused `v3-artifacts` | none |
| `apps/worker` | dependencies: `v3-text`, `v3-acquisition`, unused `v3-channels` | none |
| `packages/channels/core` | dependencies: `v3-acquisition` | dependencies: `image-size: 2.0.2`, `ipaddr.js: catalog:` |
| `packages/channels/swanson` | devDependencies: `v3-channels` | none |
| `packages/app` | dependencies: `v3-channels` | none |
| `packages/workflows` | devDependencies: `v3-channels` | devDependencies: `channel-swanson` |
| `packages/v3-acquisition` | none | devDependencies: `channels-core`, `platform` |
| `packages/v3-channels` | none | devDependencies: `channels-core`, `channel-swanson`, `platform` |

Keep `packages/workflows`'s `v3-product` dependency for the versioned gate, and keep `v3-contracts` everywhere needed. No processing manifest change is needed. The compatibility packages continue to need their existing legacy dependencies.

Validation used eight local-only `node_modules` links to already-installed dependencies, without installing anything or editing manifests/lockfiles:

- channels/core: `image-size`, `ipaddr.js` (the same installed versions used by v3-acquisition).
- workflows: `@crawl-automation/channel-swanson`.
- v3-acquisition: `@crawl-automation/channels-core`, `@crawl-automation/platform`.
- v3-channels: `@crawl-automation/channels-core`, `@crawl-automation/channel-swanson`, `@crawl-automation/platform`.

A fresh checkout needs the listed manifest changes and a subsequent lockfile/install update before it can reproduce these checks. These are intentionally not performed under this task's restrictions.

## Remaining baseline

Both entries use rule `new-code-does-not-import-old-packages`, targeting `packages/v3-product/src/resource-workflow.ts`:

1. `packages/workflows/src/resources/testing/legacy-gate.ts`
2. `packages/workflows/src/resources/versioned-gate.ts`

A final grep also finds `versioned-gate.test.ts`'s mock string for that same intentional gate. No other non-contract legacy package imports remain in the governed source folders.

## Verification

`pnpm -s check` exited 0:

```text
All matched files use Prettier code style!
no dependency violations found (1359 modules, 4769 dependencies cruised)
2 known violations ignored
Found 0 clones. (450 files)
Tasks: 35 successful, 35 total
```

Focused verification: **10 files, 82 tests passed**. This includes all four compatibility suites, both migrated application test files, the product workflow test, worker label-store test, and the remaining Swanson capture/static-parser tests.

The full `pnpm -s test:v3` ran with a temporary `/tmp/r01-offline.cjs` preload blocking network sockets, fetch, and Temporal native server/client startup, plus `V3_TEST_SKIP_POSTGRES=1 V3_TEST_POSTGRES=0`. The preload is outside the repository; test source/configuration was not changed to hide unavailable tests. The first product-pipeline replay suite reached the existing sandbox restriction before the native Temporal guard was completed and failed with `Operation not permitted`; later Temporal suites were blocked explicitly.

```text
Test Files  12 failed | 396 passed | 3 skipped (411)
Tests       5 failed | 4031 passed | 124 skipped (4160)
Errors      5 errors
Duration    99.17s
```

All failures are unavailable network/server tests, not R01 assertion failures. The five test failures and five unhandled errors came from loopback servers being denied; two OCR suites failed setup for the same reason. Seven Temporal suites failed setup. All affected R01 suites, the error registry audit, and the workflow bundle test passed in the full run.

Temporal suites unavailable:

- `packages/workflows/src/browser-scan-workflow.replay.test.ts`
- `packages/workflows/src/product-pipeline-workflow.replay.test.ts`
- `packages/workflows/src/collection/collection-workflow.temporal.test.ts`
- `packages/workflows/src/label/label-heartbeat.temporal.test.ts`
- `packages/workflows/src/label/label-workflow.replay.test.ts`
- `packages/workflows/src/resources/resource-gate.replay.test.ts`
- `packages/workflows/src/resources/resource-gate.temporal.test.ts`

Socket-dependent suites unavailable:

- `packages/v3-ocr/src/compatibility.test.ts`
- `packages/v3-ocr/src/http.test.ts`
- `packages/v3-acquisition/src/cdp-wire.test.ts`
- `apps/v3-workers/src/dependency-probes.test.ts` (one OCR health case)
- `apps/v3-workers/src/brand-entry/scan-cli.test.ts` (three loopback scan cases)

PostgreSQL cases skipped:

- `packages/adapters/src/migrations/umzug-runner.test.ts`: 17.
- `packages/adapters/src/postgres/html-capture-postgres.test.ts`: 20.
- `packages/adapters/src/postgres/postgres-queue-store-migration.test.ts`: 4.
- `packages/adapters/src/postgres/brand-scan-amazon.test.ts`: 2 database cases (three other tests passed).

Three pre-existing fixture-related cases were also skipped (two DTC saved-page cases and one Amazon Store case).

Logs remain locally at `/tmp/r01-deps-empty.log`, `/tmp/r01-check.log`, `/tmp/r01-focused-tests.log`, and `/tmp/r01-test-v3.log`. `git diff --check` passed for the changed source and dependency-rule files; manifest and lockfile diffs are empty.
