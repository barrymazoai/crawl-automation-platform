# R64 attribution and R67 measurement handoff

The read-only procedure is `usage.summary({ from, to, channel? })`. Times are ISO UTC;
the window is `[from, to)`. It reports accepted product runs, queue attempts, fresh
completed captures, capture reuses, reported credits and unknown-cost counts, model
client calls by text/image/enrichment, OCR calls, brand requests/reuses, preparation
recomputations/reuses, and median/p90 milliseconds per step and measurement kind.
Activity elapsed and provider elapsed are separate rows: do not add overlapping rows.

Apply **migration 041** through the existing migration API before starting the new
workers/API. No new configuration, service, automatic start, paid request, or retry
is introduced. No migration or deployment was performed by this change.

## Attribution and measurement decisions

- AsyncLocalStorage isolates concurrent activity identities. Nested vision
  `input.selection.observation`, OCR/text observations, preparation owners and
  pipeline envelopes all resolve the product's request ID. `product_run` resolves
  the channel; source lookup covers older observations. Temporal run IDs remain a
  separate field. Enrichment can resolve its collected-product owner.
- Pino's context mixin also attributes nested helper logs. Unknown/non-product
  owners remain null; nothing invents an allocation. `unattributedEvents` exposes
  rows without a channel.
- A decorator at each model/OCR client and the page reader records actual client
  invocations separately from activity completions. Recovered model/receipt
  results and archived HTML do not count as new model/provider calls. Brand page
  records retain the scan and request identity, not just a scan total.
- The Codex client returns a string, not token usage. Tokens remain null and
  `modelCallsWithoutTokens` exposes this. Counts mean client calls, not Codex's
  internal requests. Reported ScraperAPI credits are not a dollar estimate.
- HTML credit cost is copied from the measured page fetch into
  `html_capture.credit_cost` at completion/failure; cross-operation reuse records
  zero additional credits. `page-fetch.ts` already passes `page.creditCost` in
  `fetchedVia`, so it required no edit. Historical missing costs remain null.
- Measurement write failures are logged without changing a paid operation's result
  or retrying it. The SQL report covers persisted observations; an abrupt worker
  death or unavailable telemetry database can leave gaps. Historical logs are not
  retroactively reconstructed.

## Queue attempt history

Migration 027 already created `queue_attempt`. `PostgresQueueDispatch.claim()`
already inserts a row in the same CTE/transaction that starts the item, and
`settle()` updates that row. Migration 041 adds its reporting index, not another
history table. The new `QueueAttempts` port and transaction-scoped
`PostgresQueueAttempts` adapter expose start/finish/list, including idempotence and
identity-conflict checks. No extra start call should be added to the existing
dispatcher: it would duplicate an already-recorded event. A future replacement of
that CTE must call `new PostgresQueueAttempts(transaction).start(...)` in the item
transition's transaction, and `.finish(...)` in settlement's transaction. Never
record an attempt on requeue alone. `postgres-channel-queue-store.ts` is untouched.

## R67: measured now, reuse fix deferred

`measuredLabelPlans` decorates `LabelPlans.source()` at worker construction. It
records every source preparation, including manifest's internal `this.source()`
calls, with `cacheHit: false` (recomputed). `label-plans.ts` was not edited.

The later reuse fix should read the source receipt at `labelKeys.source(input,id)`
first, verify its owner, source identity/hash, policy/config fingerprints and
artifact integrity, then reuse the exact result. Manifest construction should use
that verified source receipt instead of invoking the resolver and label source
builder again. A missing receipt may be recomputed from retained evidence; an
unverifiable/conflicting receipt must not trigger a paid retry. The measurement
decorator must then receive the verified reused/recomputed disposition instead of
the current unconditional recomputed fact.

## Files owned by this change

- `apps/worker/src/activities/activity-log.ts`, `activity-guard.ts`,
  `activity-guard.test.ts`, `activity-identity.ts`, `activity-context.ts`,
  `activity-context-handler.ts`, `activity-context-parts.ts`,
  `activity-context.test.ts`, `activity-outcome.ts`, `activity-provider-context.ts`.
- `packages/platform/src/logging/measurement-context.ts`, `measured-call.ts`,
  `measurement-context.test.ts`.
- `packages/adapters/src/postgres/html-capture-records.ts`,
  `html-capture-queries.ts`, `html-capture-cost.ts`, `usage-measurements.ts`,
  `usage-reader.ts`, `usage-summary-query.ts`, `queue-attempts.ts`, `usage.test.ts`.
- `packages/app/src/usage/{index,usage-model,usage-service,queue-attempts}.ts`,
  `usage-service.test.ts`, this handoff.
- `apps/api/src/routers/usage.ts`, `apps/api/src/usage-parts.ts`,
  `apps/api/src/usage-router.test.ts`; `database/v3/041_usage_attribution.sql`.

Shared additive wiring (other agents' unrelated changes are retained):

- Package `index.ts` exports in platform, app and adapters.
- Worker `container.ts` context registration; `capture-records.ts` page decorator;
  `label/label-models.ts` model/OCR decorators; `label/label-steps.ts` preparation
  decorator; `activities/brand-listing-activities.ts` request decorator;
  `activities/enrichment-activities.ts` enrichment model decorator;
  `activities/label-activities.ts` context for idempotent control activities.
- Platform `logger/create-logger.ts` context mixin, `logger/recovery.ts` and
  `storage/storage-logger.ts` owner propagation.
- API `container.ts`, `trpc.ts`, `api-context.ts` service wiring and
  `routers/app-router.ts` usage registration.

## Validation

Latest focused run: **39 tests passed** (platform 9, worker 17, adapters 8,
application 4, API 1). Scoped ESLint and Prettier pass. Platform and application
type checks pass. Worker/API/adapters type checks still report parallel-work
errors: the permit activity context requires a non-optional workflow execution,
the enrichment router's optional service type differs under exact optional
properties, adapter recheck test mocks have generic database signature mismatches,
and the temporary PostgreSQL test helper cannot resolve `pg` declarations. Those
other agents' errors were not changed. The API container's enrichment registration
also had a formatting failure outside this change's additive usage registration.

Focused unit tests cover nested/concurrent identity, logger propagation, provider
versus receipt reuse, all model call kinds, preparation repeated by manifest,
brand request costs/reuse, capture credits and sums, attempt identity/idempotence,
the read-only SQL adapter contract and fixture-based API/service summaries.
PostgreSQL execution, migration application, Temporal replay/server tests and live
provider tests were not run (parallel-run sandbox rules). No workflow logic was
changed. The SQL aggregation itself still needs the PostgreSQL acceptance test.
