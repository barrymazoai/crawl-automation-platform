# Brand scan permit and challenge classification handoff

Implemented locally on 2026-09-30; no deployment, database migration, paid request, historical Review retry,
or Git state-changing command was performed. Drug Facts, label schemas, processing/assembly and blend
validation edits in the shared workspace belong to other jobs and were not edited by this task.

The API runner performs listing reads; CollectionWorkflow only watches the scan table. Configured channels
now delegate their listing read to a new BrandListingWorkflow, which uses the existing ResourceGate and
resource_capacity ledger. The permit covers every page and family expansion, and is released before queue
insertion. Unconfigured channels keep the existing path. Activity retries are disabled; reconnecting to a scan
uses its existing workflow, including a closed workflow's result. No existing workflow command sequence changed,
so no patched() branch is required. Replay coverage for the new workflow is provided for the main session.

Shopify and Cloudflare challenge markers are refused before following a redirect. The shared transport emits
the registered SOURCE.ACCESS_CHALLENGE code; ListingPages converts it to the existing
BRAND_SCAN.ACCESS_CHALLENGE code. Ordinary redirects retain their existing handling. The paid challenge request
is never followed or retried.

Server 一 settings and rollout steps are in [machines.md](../operations/machines.md#brand-scan-并发许可server-一配置2026-09-30).
API: brandScans.permits.swanson names swanson-brand-scan, v3.pipeline.product.v1, v3.resources.v1 and
maxWaitSeconds=900. Worker: brandScans contains the API's listing route, scraperApi and channels; storage.r2 must
resolve the existing listing archive. The resources role maps swanson-brand-scan to v3.pipeline.product.v1.
Migration 036 inserts capacity 1 only when absent, leaves existing capacity unchanged and adds no grants.
The resource is classified as http-lane. The unchanged ResourceGate policy limits unhealthy waiting by
maxWaitSeconds and healthy occupied capacity by 400 backoff polls; maxWaitSeconds is not a strict wall-clock
deadline for occupied healthy capacity.

Validation:

- pnpm lint: passed (also included in pnpm check).
- pnpm check: passed, including dependencies, zero duplicate code and all 21 TypeScript tasks.
- Touched-package offline Vitest run: 159 files passed, 1,204 tests passed, 47 PostgreSQL tests skipped.
  Temporal/replay tests and the PostgreSQL-only brand-scan-amazon file were excluded from this MacBook run.
- New tests cover capacity 1 held, wait-limit Review without listing execution, exact permit release,
  challenge refusal without a second request, Review-code propagation, durable scan reattachment,
  capability-based worker routing and unconfigured GNC/Amazon scans.
- New Temporal/replay cases cover two scans sharing capacity 1, successful/failed release and wait expiry.
  Run these and PostgreSQL migrations on the permitted test host before deployment; no saved history is added.

```sh
V3_TEST_SKIP_POSTGRES=1 pnpm exec vitest run --config vitest.v3.config.ts \
  apps/api/src apps/worker/src packages/app/src packages/adapters/src \
  packages/platform/src packages/channels/core/src packages/workflows/src \
  --exclude '**/*.temporal.test.ts' --exclude '**/*.replay.test.ts' \
  --exclude '**/brand-scan-amazon.test.ts'

# Main session / Mini:
pnpm exec vitest run --config vitest.v3.config.ts \
  packages/workflows/src/collection/brand-listing-workflow.replay.test.ts \
  packages/adapters/src/migrations/umzug-runner.test.ts
```

Files changed or added by this task (paths are relative to the repository; other working-tree changes are excluded):

| Directory | Files |
| --- | --- |
| apps/api/src | brand-scan-config.ts; brand-scan-parts.ts; brand-scan-permits.test.ts |
| apps/worker/src | config.ts; activities/brand-listing-activities.ts; activities/brand-listing-activities.test.ts; processes/role-settings.ts; processes/role-workers.ts; browser/browser-only.test.ts |
| packages/app/src/brand-scans | brand-scan-runner.ts; scan-listing.ts; scan-permits.ts; scan-permits.test.ts; index.ts |
| packages/adapters/src | temporal/temporal-brand-listings.ts; temporal/temporal-brand-listings.test.ts; migrations/sql-catalog.test.ts; migrations/umzug-runner.test.ts; index.ts |
| packages/workflows/src | collection/brand-listing-model.ts; collection/brand-listing-workflow.ts; collection/brand-listing-workflow.test.ts; collection/brand-listing-workflow.replay.test.ts; index.ts; workflows.ts |
| packages/channels/core/src | listing/listing-fetch-settings.ts; listing/listing-pages-factory.ts; listing/listing-pages.ts; listing/listing-pages.test.ts; resource-kinds.ts; index.ts |
| packages/platform/src/fetch | scraperapi-client.ts; scraperapi-client.test.ts; scraperapi-errors.ts; scraperapi-redirects.ts; scraperapi-redirects.test.ts |
| database/v3 | 036_brand_scan_capacity.sql |
| docs | operations/machines.md; quality/brand-scan-permits.md |
