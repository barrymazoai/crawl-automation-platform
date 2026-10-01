# Seven-change integration validation

The working tree remains uncommitted. No deployment, migration application, provider request,
Git branch/worktree/stash/reset/checkout, or server connection was performed.

## Changes by requested step

1. Removed all seven dependency cycles by extracting resource binding, label step, ordered walk
   and Review store contracts. Logger measurement code imports the Pino type directly; the usage
   factory depends only on the database port. No dependency rules or baselines were changed.
2. New product source plans persist `label-sources/1`, using validated `plan.sourceOrder` overrides.
   Amazon (including Whole Foods formula requests) defaults to images-first; GNC, Swanson, Costco
   and DTC default to text-first. Label tasks keep the existing R53 passthrough, packaging admission
   and `label-image-first/6`. Tests cover absent legacy policy, defaults, overrides and invalid config.
   The config fragment is in [machines.md](machines.md#label-source-order-r52-integration-source-only).
3. Completed strict typing without casts that suppress the missing workflow owner: worker activities
   reject ownerless execution before invoking their handlers. Declared the adapters PostgreSQL type
   dependency using the existing catalog version; the lockfile adds only that importer entry.
   Split the larger pipeline fixture and source-plan method to retain the existing lint limits.
4. Updated workflow mocks for signals, logging and durable permit stop checks. Legacy routing fixtures
   explicitly retain their pre-enrichment markers. Updated exact assertions for usage outcome codes,
   inactive image fallback descriptors and Whole Foods catalogue agreement/missing-listing gating.
5. Reviewed 039–042 against earlier schemas and pinned all 42 migration hashes. Documented 040 terminal
   duplicate preservation, added 042 runtime grants and made the 041 historical reuse backfill tolerate
   missing capture operation IDs without inventing a cost. Added an opt-in PostgreSQL acceptance suite.
   See [migration details](../../database/v3/INTEGRATION.md).
6. `pnpm check` passed completely: ESLint, Prettier, dependency boundaries, zero duplicate-code
   clones and all 22 TypeScript tasks. The two existing dependency baseline entries are unchanged.

## Package test results

Each package was run with `pnpm --filter @crawl-automation/<package> exec vitest run`,
`--maxWorkers=2` and default/JSON reporters. Failed integration cases were fixed and affected
packages rerun. Counts below are the final distinct test counts, not the sum of reruns.

| Package | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| platform | 233 | 0 | 0 |
| v3-contracts | 120 | 0 | 0 |
| processing | 1316 | 0 | 1 |
| channels-core | 130 | 0 | 0 |
| channel-amazon | 204 | 0 | 1 |
| channels-gnc | 74 | 0 | 0 |
| channel-swanson | 97 | 0 | 0 |
| channels-wholefoods | 79 | 0 | 0 |
| channels-costco | 51 | 0 | 4 |
| channel-dtc | 104 | 0 | 6 |
| app | 494 | 0 | 0 |
| workflows | 169 | 0 | 2 |
| adapters | 177 | 0 | 53 |
| worker | 155 | 0 | 0 |
| api | 184 | 0 | 0 |
| **Total** | **3587** | **0** | **67** |

PostgreSQL flags: `V3_TEST_SKIP_POSTGRES=1`, `V3_TEST_POSTGRES=0`, `CRAWLER_TEST_POSTGRES=0`.
Adapters additionally exclude `integration/**`. Workflows exclude `**/*.temporal.test.ts`
and `**/*.replay.test.ts`; bundle and serverless saved-history tests remain in the selected suite.

## Tests not executed

PostgreSQL-dependent tests under `packages/adapters/src/` (53 cases skipped):

- `migrations/integration-migrations.test.ts`
- `migrations/umzug-runner.test.ts`
- `postgres/brand-scan-amazon.test.ts`
- `postgres/html-capture-postgres.test.ts`
- `postgres/postgres-queue-store-migration.test.ts`
- `postgres/postgres-resource-health.test.ts`

PostgreSQL suites under `packages/adapters/integration/` (excluded):

- `brand-scans.test.ts`
- `channel-queue.test.ts`
- `formula-reuse.test.ts`
- `listing-states.test.ts`
- `metrics-history.test.ts`
- `pipeline-stores.test.ts`
- `queue-coalescing.test.ts`
- `review-records.test.ts`

Temporal-server suites under `packages/workflows/src/` (excluded):

- `browser-scan-workflow.replay.test.ts`
- `collection/brand-listing-workflow.replay.test.ts`
- `collection/collection-workflow.temporal.test.ts`
- `family-product.replay.test.ts`
- `label/label-heartbeat.temporal.test.ts`
- `label/label-workflow.replay.test.ts`
- `product-pipeline-workflow.replay.test.ts`
- `resources/resource-gate.replay.test.ts`
- `resources/resource-gate.temporal.test.ts`

Missing external evidence/history (14 cases skipped):

- Processing saved-label evidence replay (1).
- Amazon retained Store listing fixture (1).
- Costco retained page fixtures (4).
- DTC retained page fixtures (6).
- Pre-enrichment product history replay (1) and pre-source-order label history replay (1).

No live provider, browser, end-to-end product acceptance, PostgreSQL migration execution or
Temporal-server replay was performed. These remain deployment acceptance checks; unit and
bundle results do not establish live readiness.
