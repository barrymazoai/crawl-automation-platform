# Browser connection recovery handoff

Changes are in the working tree only. No commit, push, branch, deployment, live browser,
PostgreSQL integration test, or Temporal server replay was performed. Existing unrelated
changes, AGENTS.md, docs/*, and the concurrent DTC implementation were preserved.

## Behavior and stop evidence

- Resource health now probes the local Ego CLI, the configured numeric space's existence,
  fresh agent ownership, and its tab inventory. It never creates, claims or takes over a space.
- Local pre-admission probing writes unhealthy health before ordinary resource admission.
  Admission still honors prior committed grants; it does not hide one behind a new wait.
- Browser outage reasons survive admission as `browser:BROWSER.*`. The new
  `browser-resource-outage-wait-v1` marker keeps these waits cancellable without consuming the
  old wait deadline/poll budget. Waiting work resumes; interrupted business work is not replayed.
- Each page round probes before opening. Fresh listTaskSpaces observations replace stale
  task.ownership snapshots before opening and cleanup. Store and product production paths
  now use the same EgoPages/R59 lifecycle.
- Every CLI call has a deadline and Execa SIGKILL escalation, including its owned descendants.
  No existing browser process is killed. Probe, cleanup and business deadlines are separate.
- R59 journals record a round baseline, its CLI execution, and streamed exact page identities.
  CLI exit is proved separately from page absence. After cleanup the round checks its space's
  inventory against the baseline before proving completion.
- A browser-process recovery loop reads only ended activities with the new journal protocol
  on the same host and configured space. It closes only registered, agent-created targets,
  rechecks absence and publishes the existing R59 stop receipts. It uses ResourceService for
  terminal-owner release after the workflow's bounded cleanup window; an active workflow uses
  its existing stopResourceExecution/release path. Original failures are retained.
- Readiness exceptions, including uncoded exceptions, cannot pass partial HTML to content
  classification. They become BROWSER.UNAVAILABLE infrastructure failures.

Conservative boundaries: user control, missing spaces, unknown new tabs/popups, an unreported
newPage result, absent CLI exit proof, or old journals without this protocol remain explicitly
cleanup-pending. Neither elapsed time nor CLI exit alone proves that pages stopped. No inferred
ownership, space recreation, permit-only release, or automatic business requeue was added.

## Config and rollout

Defaults under browser.ego, milliseconds:

| Key                       | Default |
| ------------------------- | ------: |
| roundTimeoutMs (existing) |  180000 |
| probeTimeoutMs            |    3000 |
| cleanupTimeoutMs          |    5000 |
| killGraceMs               |    1000 |
| recoveryIntervalMs        |    5000 |

Existing resourceHealth.intervalMs/ttlMs defaults remain 5000/15000. Add
`browser: true` to each local browser health target explicitly, or let resourceKinds / the
configured browser role's task queue identify it. For Server 二, bind resourceKinds and the
health target for server2-ego-space-6 to browser.ego.taskSpaceId=6. Configure the absolute local
cliPath and the actual controller owning that resource row. The resources health process must
probe that host's Ego; do not list a remote host's browser row under a local Ego monitor.
Space 1 dtc-bridge is never used. All process starts remain manual.

The existing R59 migration 042 journal/trigger is required; no new migration was added.
Deploy compatible contracts/workflow code with the new browser wait reason before new resource
activities emit it. The main session owns deployment and its replay/PG checks.
Routing was not redesigned: verify that the resource granted to a browser activity corresponds
to the host/space actually executing it, especially before activating two hosts on a shared
browser task queue.

## Validation

- Focused browser/resource/admission/gate suite: 21 files, 160 tests passed.
- Final platform browser suite after final inventory-proof tightening: 6 files, 47 tests passed.
- Package-wide offline run: 1299 passed, 47 skipped, 2 failed. The two failures are in
  apps/worker/src/browser/dtc-source-pipeline.test.ts (concurrent DTC brand-sighting behavior;
  PipelineCapture's fake listing repository returns undefined observationId). Left unchanged.
- check-types passed for platform, app, adapters, worker, workflows and v3-contracts.
- ESLint and Prettier passed for owned files; git diff --check passed.
- Fake CLI exercises down/missing/user-owned -> healthy, disconnect during capture, exact-page
  cleanup, a stale ownership handle, page crash, readiness failure, missing executable, and a
  hung CLI plus child ignoring SIGTERM. The latter verifies both PIDs disappear.
- Replay test added in packages/workflows/src/resources/browser-outage.replay.test.ts. It
  generates old/new histories in memory, checks hasMarker(), and replays both against current
  code. Actual Temporal-server execution is intentionally left to the main session. Workflow
  bundle tests and mocked gate tests passed, including 450 outage polls then one business call.

## Main-session acceptance

1. Run the new Temporal replay test and the existing R59 PostgreSQL tests; verify the pending
   browser query and post-recovery trigger/release path against PostgreSQL.
2. With Ego quit on Server 二, submit one permit-gated scan: expect browser unhealthy, waiting
   workflow, no new page, no new permit, no content verdict. Restore the existing agent-owned
   space 6: health and waiting work must recover without restarting the worker.
3. Quit/restart Ego after a scan reports an opened target. Expect a registered infrastructure
   failure, durable cleanup pending and held permit. On return, verify exact-target absence,
   CLI/page/round receipts, then permit release. Verify only one business attempt; requeue only
   explicitly through the existing queue operation.
4. Take user control during the scan. Verify no takeover, claim, close or cleanup while user-owned.
   Return space 6 to agent ownership deliberately and verify pending cleanup resumes.
5. Crash/close the exact task page, test cancellation, and inspect timeout/kill behavior. Preserve
   an unrelated user tab and space 1 throughout. Confirm no content-bad-page verdict for outages.

## Owned file inventory

Production files:

- apps/worker/src/activities/resource-activities.ts
- apps/worker/src/browser/browser-parts.ts
- apps/worker/src/browser/browser-recovery-parts.ts (new)
- apps/worker/src/browser/scan-wiring.ts
- apps/worker/src/browser/store-rounds.ts
- apps/worker/src/processes/run-process.ts
- apps/worker/src/resources/browser-health.ts (new)
- apps/worker/src/resources/resource-health-config.ts
- apps/worker/src/resources/resource-health-parts.ts
- packages/platform/src/browser/ego-cleanup.ts
- packages/platform/src/browser/ego-errors.ts
- packages/platform/src/browser/ego-health.ts (new)
- packages/platform/src/browser/ego-output.ts
- packages/platform/src/browser/ego-ownership.ts (new)
- packages/platform/src/browser/ego-pages.ts
- packages/platform/src/browser/ego-runner.ts
- packages/platform/src/browser/ego-script.ts
- packages/platform/src/browser/ego-settings.ts
- packages/platform/src/browser/ego-stop.ts (new)
- packages/platform/src/browser/index.ts
- packages/platform/src/execution/permit-execution.ts
- packages/app/src/index.ts (one export)
- packages/app/src/resources/browser-recovery.ts (new)
- packages/app/src/resources/health-ports.ts
- packages/app/src/resources/resource-health.ts
- packages/adapters/src/postgres/pending-browser-executions.ts (new)
- packages/adapters/src/postgres/postgres-permit-executions.ts
- packages/adapters/src/postgres/postgres-resource-admission.ts
- packages/workflows/src/resources/wait-for-resource.ts
- packages/v3-contracts/src/resources.ts

Tests and replay helpers:

- apps/worker/src/browser/browser-only.test.ts
- apps/worker/src/browser/managed-rounds.test.ts
- apps/worker/src/processes/run-process.test.ts
- apps/worker/src/resources/browser-health.test.ts (new)
- packages/platform/src/browser/ego-availability.test.ts (new)
- packages/platform/src/browser/ego-pages.test.ts
- packages/platform/src/browser/ego-recovery.test.ts
- packages/platform/src/browser/ego-runner.test.ts
- packages/platform/src/browser/ego-script-evidence.test.ts
- packages/platform/src/browser/testing/fake-ego.ts (new)
- packages/app/src/resources/browser-recovery.test.ts (new)
- packages/adapters/src/postgres/browser-admission.test.ts (new)
- packages/workflows/src/resources/resource-gate.test.ts
- packages/workflows/src/resources/browser-outage.replay.test.ts (new)
- packages/workflows/src/testing/replay/bundles.ts
- packages/workflows/src/testing/replay/history.ts
- packages/v3-contracts/src/resources-browser.test.ts (new)
- apps/worker/BROWSER_CONNECTION_HANDOFF.md (this handoff)
