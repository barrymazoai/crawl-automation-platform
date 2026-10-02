# Permit stop verification handoff

Changes are in the working tree only. No commit, push, branch, server connection, deployment, or production permit change was made. AGENTS.md and docs/* were not edited.

## Behavior

- `resources.verifyStop` is an unauthenticated mutation taking `{ "permitId": "..." }`.
- `resources.verifyStops` is an unauthenticated mutation taking `{}`. Each call considers at most 20 persisted CLEANUP_UNVERIFIED permits. A rotating cursor prevents a running or unknown owner from starving later permits.
- Both first require the exact original workflow ID/run ID to be closed with no pending Activities. A missing Temporal execution is not proof.
- OCR recovery calls the existing `verifyOcrStop` in query-only mode: one GET of the original job, no cancel, OCR submission, or business retry. It requires the configured endpoint to equal the recorded endpoint and job control to be enabled both in configuration and the identity. `done`, `failed`, and `cancelled` with `finished_at` are proof. Recovery GETs have a 10-second ceiling (or the shorter configured OCR stop deadline).
- Browser recovery starts `VerifyBrowserStopWorkflow` on the recorded permit's one resource-specific R72 browser queue. Its one activity rechecks owner/resource/host/space, requires the original CLI exit proof, and reuses `BrowserRecovery.recover` / `stopEgoRound` / `closeAndVerifyTarget`. No reported page is resolved using the original baseline. Unknown new tabs and user control remain unverified.
- Every execution needs a durable proof. The existing journal sets stopped only after verification, and `ResourceService.release` checks the closed owner again before release. Original business failures remain intact.
- Missing identities, unsupported executor kinds, unavailable controls, running jobs and unproved CLI exits remain held with a reason. No elapsed-time release and no force option exist.
- API recovery is serialized with a PostgreSQL advisory transaction lock. Browser host cleanup has a separate resource lock, preventing another close even if Temporal times out while the prior activity is still finishing. Permit rows are not locked across provider I/O.
- The resources process calls the same HTTP mutation immediately and every configured interval after completion. Calls do not overlap in that process. Each attempt/outcome is logged. This replaces the independently wired browser-process recovery loop; the existing shared browser proof implementation remains in use.

Example response for `resources.verifyStop` (the normal tRPC HTTP envelope wraps this in `result.data`):

```json
{
  "permitId": "permit-example",
  "released": true,
  "executions": [{ "executionId": "job-example", "kind": "ocr", "stopped": true }]
}
```

Unknown status returns `released: false`, `reason: "stop_not_proven"`, and the execution reason `job_unknown`. Unreachable jobs return `job_control_failed` with the preserved cause chain. Running owners raise `PERMIT.OWNER_RUNNING` before any provider call. Sweeps return `{ "results": [...], "released": ["permit-id", ...] }`, including reasons for skipped/refused candidates.

## What the fetch investigation establishes

The original production wiring in `label-models.ts` passed `globalThis.fetch` to `ocrClient`; `ocr-client.ts` passed that same function to `/ocr` and `OcrHttpJobControl`. There was no repository-created pinned dispatcher, per-request agent, or agent-destroy call on that path. `OcrApi.post` applied its cancellation signal to `/ocr` only; `verifyOcrStop` already created a separate `AbortSignal.timeout`. Therefore an inherited upload AbortSignal or destroyed custom upload agent is **not established as the production cause**.

The confirmed diagnostic defect was `String(error)` in `verifyOcrStop`: it discarded the nested Undici/socket cause behind `TypeError: fetch failed`. The supplied historical log cannot distinguish a reset, refusal, dispatcher failure, or another connection error. A later successful CLI GET is not proof of which one occurred earlier.

The new default control transport creates a fresh Undici Agent for each control request, uses only the fresh verification signal, consumes the reply and destroys that Agent. OCR uploads keep their existing transport. Separate injected upload/control transports remain available to tests. Error reporting now retains bounded cause chains and string error codes. Tests reproduce an injected dead shared transport and show the independent control transport succeeds; this is a regression test for isolation, not a claim that this exact mechanism occurred in production.

## Configuration and rollout

No migration or new dependency is needed; the existing migration 042 journal/trigger is reused.

Before restarting the resources process, add this section to its private worker configuration (use the existing API address):

```json
{
  "stopSweep": {
    "apiUrl": "http://<private-api-host>:<api-port>/trpc",
    "intervalMs": 60000
  }
}
```

`intervalMs` defaults to 60000; the address is required. A resources process with no `stopSweep` section fails startup rather than silently omitting recovery. No boot/login startup was added.

The API must have `fleet.ocrApi` copied from the worker's actual OCR settings, including `jobControl: true` and `baseUrl: "http://192.168.68.69:8081"`. Keep the existing provider and other values. OCR activities still use `processing.ocrApi`. API and browser workers need `database.maxConnections >= 2` (validated at startup): one advisory-lock connection plus one journal connection.

The main session must review, run the integration tests below, commit/push main and deploy through Git under the existing process. Restart the updated API, browser workers (new workflow bundle and activity), resources process, and OCR worker. Do not restart the Windows OCR service or resubmit business tasks for this repair. The periodic API call may already release the permits before a manual call.

## Release the seven reported permits through the API

With `V3_API_CONFIG` set to the existing private API configuration file on Server 一, derive the address without printing credentials:

```sh
verify_stop_api="$(jq -r '"http://" + .api.host + ":" + (.api.port | tostring) + "/trpc"' "$V3_API_CONFIG")"
curl --fail-with-body -sS "$verify_stop_api/resources.permits" | jq '.result.data'
curl --fail-with-body -sS -X POST "$verify_stop_api/resources.verifyStops" \
  -H 'content-type: application/json' --data '{}' | jq '.result.data'
curl --fail-with-body -sS "$verify_stop_api/resources.permits" | jq '.result.data'
curl --fail-with-body -sS "$verify_stop_api/resources.list" | jq '.result.data'
```

For the supplied state of seven eligible permits, one bounded sweep can inspect all seven. Confirm all seven original permit IDs are absent from held permits; other newly admitted work may hold resources by then. Do not infer success from zero errors or capacity totals alone. If the automatic sweep has already released them, the manual result can be empty.

An individual held permit can be verified without sweeping unrelated candidates:

```sh
curl --fail-with-body -sS -X POST "$verify_stop_api/resources.verifyStop" \
  -H 'content-type: application/json' --data '{"permitId":"<exact-held-permit-id>"}' | jq '.result.data'
```

`verification_busy` is a concurrent recovery outcome, not permission to force a release. Inspect the returned per-execution reason when a permit remains held. The next periodic sweep revisits it.

## Validation

- Offline suite across all seven touched packages/apps: 3,207 passed, 4 skipped (309 files passed). PostgreSQL/Temporal suites excluded.
- After final cursor/config/wiring edits: 114 targeted tests passed (10 files).
- `pnpm check-types`: 22 workspace tasks passed.
- The complete production workflow entry bundled successfully with `VerifyBrowserStopWorkflow` exported (no Temporal server started).
- ESLint and Prettier: all 48 changed TypeScript files passed.
- `pnpm check:deps`: passed; only the repository's two existing baseline exceptions remain.
- The new PostgreSQL test was separately typechecked because adapters' normal tsconfig includes only src.
- Real PostgreSQL and Temporal verification remains for the main session. An initially missed legacy migration test attempted initdb, which failed on sandbox shared-memory permission before a database started; it was excluded from the final offline run.

Run these in the main session's permitted integration environment:

```sh
pnpm --filter @crawl-automation/adapters exec vitest run integration/verify-stop.test.ts --testTimeout=120000
pnpm exec vitest run --config vitest.v3.config.ts packages/workflows/src/verify-browser-stop-workflow.temporal.test.ts
```

The PostgreSQL tests cover terminal failed OCR release, unknown/unreachable retention, closed-owner sweep filtering, exact-owner proof rejection, every-execution proof enforcement, trigger refusal and concurrent recovery exclusion. The Temporal test checks host routing and single-attempt cleanup. Unit tests cover browser baseline proof, host/owner refusal, API envelopes, fresh transport/signal isolation, bounded sweeps and loop lifecycle.

## Changed TypeScript files

- `apps/api/src/config.ts`
- `apps/api/src/container.ts`
- `apps/api/src/resources/resource-parts.ts`
- `apps/api/src/resources/verify-stop-router.test.ts`
- `apps/api/src/routers/resources.ts`
- `apps/worker/src/activities/browser-activities.ts`
- `apps/worker/src/activities/browser-routing.test.ts`
- `apps/worker/src/browser/browser-only.test.ts`
- `apps/worker/src/browser/verify-browser-stop.test.ts`
- `apps/worker/src/browser/verify-browser-stop.ts`
- `apps/worker/src/config.ts`
- `apps/worker/src/label/label-models.ts`
- `apps/worker/src/label/ocr-client.test.ts`
- `apps/worker/src/label/ocr-client.ts`
- `apps/worker/src/processes/run-process.test.ts`
- `apps/worker/src/processes/run-process.ts`
- `apps/worker/src/resources/stop-sweep-settings.ts`
- `apps/worker/src/resources/stop-sweep.test.ts`
- `apps/worker/src/resources/stop-sweep.ts`
- `packages/adapters/integration/verify-stop.test.ts`
- `packages/adapters/src/index.ts`
- `packages/adapters/src/permit-stop-verifier.test.ts`
- `packages/adapters/src/permit-stop-verifier.ts`
- `packages/adapters/src/postgres/postgres-stop-verification.ts`
- `packages/adapters/src/resources-api.test.ts`
- `packages/adapters/src/resources-api.ts`
- `packages/adapters/src/temporal/temporal-browser-stop.test.ts`
- `packages/adapters/src/temporal/temporal-browser-stop.ts`
- `packages/app/src/errors.ts`
- `packages/app/src/index.ts`
- `packages/app/src/resources/browser-recovery.ts`
- `packages/app/src/resources/resource-ports.ts`
- `packages/app/src/resources/resource-service.ts`
- `packages/app/src/stops/stop-verification.test.ts`
- `packages/app/src/stops/stop-verification.ts`
- `packages/platform/src/browser/ego-stop.test.ts`
- `packages/platform/src/fetch/job-control-fetch.test.ts`
- `packages/platform/src/fetch/job-control-fetch.ts`
- `packages/platform/src/index.ts`
- `packages/processing/src/ocr/index.ts`
- `packages/processing/src/ocr/ocr-job-control.ts`
- `packages/processing/src/ocr/ocr-stop-cause.ts`
- `packages/processing/src/ocr/ocr-stop.ts`
- `packages/workflows/src/index.ts`
- `packages/workflows/src/verify-browser-stop-workflow.temporal.test.ts`
- `packages/workflows/src/verify-browser-stop-workflow.test.ts`
- `packages/workflows/src/verify-browser-stop-workflow.ts`
- `packages/workflows/src/workflows.ts`
