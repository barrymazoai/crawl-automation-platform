# Independent GNC capture Workers

2026-09-08 current access decision: follow the [per-lane persistent Profile / Computer Use runbook](GNC_ACCESS_RUNBOOK.md). Mini viewing and pooled live launchers now use fixed profiles. Operator-assisted challenge handling is not an automatic Worker capability. Do not delete profiles or rerun old Review tasks. Earlier implementation snapshots below remain historical; current deployment/evidence boundaries are in the runbook.

2026-09-07 closeout: [per-entry discovery publication](../../docs/quality/2026-09-07-gnc-discovery-closeout.md) adds independent `gnc-discovery` and `gnc-catalog-page-workflow`. Capture completes before publication is scheduled. No whole-Brand completion is implied. [Real label verification](../../docs/plane/evidence/CRAWLV3-22/README.md) succeeded for the saved back-label; the page's 3/12 servings conflict remains passive Review. Product collection using the new label codec is not yet connected.

Latest real acceptance: [one GNC page, R2 and independent file acquisition](../../docs/quality/2026-09-07-gnc-live-acquisition.md). One image downloaded and verified from a cold process. The real page exposed a gallery selector gap (fixed and replayed offline: four candidates) plus conflicting servings fields. Full-gallery processing, model extraction and collection are not yet verified; this run used module harness processes, not Temporal Workers.

Latest: [GNC product processing](GNC_PRODUCT.md) adds `gnc-product-input`, `gnc-product-workflow` and independent `gnc-file` to these entries. File downloads have private product-plan grants and selected direct/static-proxy routes. Capture-only queues below remain unchanged; downstream processing is locally tested, not deployed.

CRAWLV3-33. Local isolated integration verified; **not deployed**, no live GNC compatibility claim. PDF is paused and not required by this build.

2026-09-07 correction: capture roles now require a dedicated host Chrome/CDP browser. Raw HTTP is not a GNC page-capture entry. See [browser implementation and Mini evidence](../../docs/quality/2026-09-07-gnc-browser.md); the older Temporal integration evidence below predates this switch.

2026-09-07 private session provisioning: [exact per-file grants and command](../../docs/quality/2026-09-07-gnc-session-grants.md). `provision:gnc-file` reads a published plan and a dedicated Chrome session, then writes a private file Worker config. No secrets in Workflow history/common evidence; no automatic distribution yet. Mini 287 regression tests and one isolated real Chrome protocol test passed; live image acceptance remains pending.

## Roles and boundaries

| Role | Queue | Registers |
| --- | --- | --- |
| `gnc-catalog` | `v3.gnc.catalog.v1.gnc-v1` | `captureGncCatalog`: one catalog page |
| `gnc-product` | `v3.gnc.product.v1.gnc-v1` | `captureGncProduct`: one exact SKU |
| `gnc-receipt` | `v3.gnc.receipt.v1.gnc-v1` | `resolveGncReceipt`: verify existing R2 / Review evidence |
| `gnc-workflow` | `v3.gnc.workflow.v1.gnc-workflow-v1` | `GncCaptureWorkflow`: choose capture role, then verify receipt |
| `gnc-discovery` | `v3.gnc.discovery.v1.gnc-discovery-v1` | `publishGncDiscovery`: one verified catalog entry |
| `gnc-catalog-page-workflow` | `v3.gnc.catalog.page.v1.gnc-catalog-page-v1` | `GncCatalogPageWorkflow`: capture one page, publish each entry independently |

Each role is independently started in a process with its own host ID, local journal, concurrency and configuration. Workers initiate Temporal connections; no public inbound port or Temporal database access is needed. Workflow code cannot fetch pages or use R2/PG. Queue constants and validated input/receipt schemas live in `packages/v3-contracts`.

The discovery role uses the same private config base as receipt (`role`, `journalRoot`, `r2`, `r2Credentials`, `reviewDatabase`), without browser/network/grants. It requires GET/conditional-PUT for its isolated discovery prefix and Review INSERT/SELECT; no model/capture credentials. Its input is `{task: originalCatalogAcquireInput, index: zeroBasedIndex}`. The page Workflow takes `{task}` and only accepts catalog-page input. It returns counts/Review references, never `brandComplete:true`. Products can consume each durable `v3/gnc-discoveries/<id>/discovery.json`; automatic admission, next-page traversal and family expansion belong to CatalogWorkflow (task36), not an R2-list polling queue.

Start discovery with the Activity entry `gnc-worker.js`, role/capability/compatibility `gnc-discovery` / `gnc.discovery` / `gnc-discovery-v1`. Start the page Workflow with `gnc-workflow-worker.js`, `gnc-catalog-page-workflow` / `gnc.catalog.page` / `gnc-catalog-page-v1`. Use build IDs from the copied complete directory's `--list`; neither role autostarts. Missing/failed discovery execution remains visible in Temporal history and preserves already published entries; it must not retry capture.

```
GncCaptureWorkflow
  → catalog-page OR product Activity
      → rendered DOM HTML + parsed evidence durably retained
      → Activity completes; capture slot released
  → receipt Activity (may remain queued while its Worker is offline)
      → independently verify existing evidence
  → durable / passive Review
```

Capture failure or invalid/lost response does **not** schedule capture again. The Workflow requests independent verification with a null receipt hint. A retained durable result can still succeed; confirmed Review remains passive; missing proof becomes `GNC.NOT_DURABLE`. Capture exceptions such as rejected grants remain visible in Temporal history; a missing-proof Review does not assert that capture executed. Cancellation propagates without scheduling fallback receipt work.

Error-page retention: bounded UTF-8 HTML with verified ownership is retained before status/DOM rejection, including a browser-rendered HTTP 307 challenge. Received HTML is evidence of a response, not successful product capture: failed pages produce no parsed evidence/completion. Challenge, not-found and HTTP-status failures use passive SOURCE Review; ordinary errors do not become challenges merely because scripts mention a CAPTCHA library. Unsafe/unowned or non-HTML responses are not retained through this HTML-only interface. Publication failure remains a storage error; same-operation recovery never recrawls. The standard receipt has no newly added response-status/header fields. See [verification and limits](../../docs/quality/2026-09-07-gnc-challenge-retention.md).

Both Activity types use maximumAttempts=1, heartbeat every 2s, heartbeat timeout 15s, start-to-close 5 minutes and schedule-to-close 24 hours. Start-to-close does not run while waiting for an absent Worker. These are bounded queue/processing deadlines, not perpetual waiting. Failure of the receipt Worker/storage itself can fail the Workflow; do not claim Review persisted unless it was confirmed. Inspect retained evidence and use an explicitly authorized recovery path, not a blanket capture retry.

`ResolveGncReceipt` has no reader, parser or `resume` call. It can append and confirm a passive Review but cannot upload missing source/parsed artifacts. Its private schema rejects crawl network settings/grants. Its R2 credentials should be read-only in deployment; capture roles need the existing immutable GET/conditional-PUT access. No delete is required by either role.

## Build / start

```sh
pnpm --filter @crawl-automation/v3-workers build:gnc
node apps/v3-workers/dist/gnc/gnc-worker.js --list
node apps/v3-workers/dist/gnc/gnc-workflow-worker.js --list
```

The dedicated `dist/gnc` directory contains both entries, any shared JS chunks and the Workflow CJS bundle. Keep the whole directory and production dependencies. Build IDs hash actual artifacts, including shared chunks; copy the matching `--list` buildId into runtime config. Do not mix files from different builds. `--list` is metadata-only and does not require provider credentials or connect to services.

Each process requires `V3_WORKER_ENABLED=true` and an absolute `V3_WORKER_CONFIG`, following the [shared runtime config](README.md). Set role/capability/compatibility from the table, contractVersion=1, expectedBuildId from `--list`, unique hostId, explicit namespace/address and concurrency. Workflow concurrency must be at least 2; browser capture must be 1 (startup rejects other values). Remote Temporal requires the existing mTLS transport; plaintext local mode is loopback-only.

Capture and receipt processes additionally require `V3_GNC_LIVE_ENABLED=true` and an absolute `V3_GNC_CONFIG`. This private JSON file must be a regular non-symlink file, ≤4 MiB, mode 0600 on POSIX. Both opt-ins default off. Example shape (placeholders, not a runnable configuration):

```json
{
  "role": "gnc-product",
  "journalRoot": "/absolute/private/gnc-product/journal",
  "r2": { "endpoint": "https://<account>.r2.cloudflarestorage.com", "bucket": "<bucket>", "prefix": "<isolated-prefix>" },
  "r2Credentials": { "accessKeyId": "<private>", "secretAccessKey": "<private>" },
  "reviewDatabase": { "connectionString": "<private V3 Review URL>", "tls": true },
  "network": { "routeId": "dedicated-chrome", "version": "browser-cdp-1", "egressId": "gnc-lane/1", "mode": "host", "managed": false },
  "browser": { "endpoint": "http://127.0.0.1:9223", "instanceId": "<actual browser UUID from local CDP json/version>", "sessionId": "<same session as all grants>" },
  "grants": [{ "task": "<full GncAcquireInput object, not a string>", "expiresAt": "<UTC ISO timestamp>" }]
}
```

For `gnc-receipt`, change role and **omit network, browser and grants**. Use separate journal/credentials. The Workflow process does not need GNC private config, R2 or Review credentials. The Review DB role needs SELECT/INSERT on the migrated V3 `review_record` table, not access to the old or Temporal database.

Grants are exact full task authorizations, including Observation, capture, and network metadata, with expiry. Capture config no longer accepts manual headers or proxyUrl; browser cookies and networking belong to its dedicated profile. Each grant must match the selected role, route and browser session. Maximum 1,000 unique operations; no wildcard/host-wide grants. Expiry blocks new navigation, not read-only recovery of already completed evidence. This is the current bounded integration configuration, **not** a finished dynamic Brand authorization service.

`GncBrowserReader` uses `CdpRenderedBrowser`: localhost CDP controls a dedicated, already running Chrome instance; the target site is loaded by Page.navigate, not Node fetch/curl. Startup verifies its exact browser UUID; each read creates and closes only its own tab, and main-document status is correlated by frame/loader. Unexpected top-frame navigation is blocked, DOM is bounded at 2 MiB, total read deadline is 45 seconds, no retry or HTTP fallback. Rendering uses the old load-event + 1.5-second settle behavior; site-specific lazy panels/gallery completeness still need live acceptance.

The operator must provide one exclusively owned Chrome/profile per capture Worker and configure its network beforehand. A session/egress ID is an assertion, not proof of physical IP. Cross-process browser leases/automatic launch/rotation are not implemented; do not point concurrent Workers at the same profile. `host` now means this supplied browser's real network; `static-proxy` metadata does not itself reconfigure Chrome. Restarted Chrome has a new instance ID, requiring explicit updated private config. Old HTTP-only capture config fails startup. Use a new route version/new task identities; do not rewrite old evidence. Never put CDP URLs, cookies or private config into Workflow history. Binary file role retains its independent direct/static-proxy implementation. Browser-cookie handoff now has the explicit private provisioning command linked above; dynamic authorization distribution and live-site acceptance remain pending.

Submit `GncCaptureWorkflow` to the Workflow queue with `args: [{ task: <GncAcquireInput> }]`, using a unique Workflow ID and an appropriate execution timeout. This entry does not expose the Web/API submission path yet. Reusing the same operation means evidence recovery, not permission for a fresh crawl; fresh collection needs new operation/observation identity.

## Verification / remaining work

```sh
pnpm --filter @crawl-automation/v3-channels test
pnpm --filter @crawl-automation/v3-workers test:gnc
```

Integration requires local PostgreSQL binaries, OpenSSL and a Temporal CLI (cached v1.8.3 or `V3_TEST_TEMPORAL_CLI`). Run on Mac mini. It starts isolated loopback Temporal/PG/HTTPS fixtures and production Worker processes. The updated test-only preload supplies synthetic CDP pages (not real Chrome) and redirects R2/file traffic while retaining TLS trust. The two image downloads still use real fixture CONNECT/TLS; the page no longer contributes a third CONNECT. Fixtures are never included in production builds. The full Temporal/PG suite has not been rerun after this browser switch; browser unit/regression and the separate real Mini Chrome probe are the current evidence.

Still pending: downstream page/image task preparation, whole-Brand incremental discovery/family expansion, Web/API routing, approved live-site and physical proxy exit verification, cross-machine deployment and Swanson. A durable GNC receipt means capture evidence is safe, **not** Formula/Ingredients interpreted or product collected. [Acceptance report](../../docs/quality/2026-09-07-gnc-workers.md).
