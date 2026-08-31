# Crawl Automation Platform

This monorepo is the deterministic controller for distributed product crawling.

- `apps/web`: Mac mini operations console (Vite, React, TanStack Router/Query, Ant Design, AG Grid, Tailwind).
- `apps/backend`: Railway control plane plus the Mac processing worker and fixed Amazon/GNC/Swanson adapters.
- `apps/browser-node`: Windows Codex + programmable Chrome worker.
- `packages/contracts`: versioned `EvidenceBundleV1`, Job, Node, and typed oRPC contracts.
- `packages/runtime`: leases, node client, local SQLite checkpoint/outbox, switchable Codex exec/App Server runners, and artifact helpers.
- `packages/ocr-client`: stateless multipart OCR API client.
- `crawl-products`: the in-repository Codex Skill and deterministic crawl helpers.

The control plane owns two finite DAGs:

- DTC: `capture (Windows Browser + crawl-products Skill) -> process (Mac OCR + Codex) -> ingest (Jakarta Observation RPC) -> cleanup`
- Amazon/GNC/Swanson: `process (Mac fixed adapter + OCR + Codex + Jakarta Observation RPC) -> cleanup`

There is no standalone OCR Job and no OCRBundle. DTC EvidenceBundle archives cross from Windows to the Mac through object storage; the Mac expands them once, calls the OCR API for all images with bounded concurrency, and processes the OCR sidecars locally. Fixed sales-channel adapters never upload an EvidenceBundle. Amazon exhausts Brand Store navigation with Mac Chrome CDP and expands ASIN variation families. GNC exhausts Salesforce Commerce Cloud pagination and `ProductGroup` variants. Swanson exhausts its Constructor brand catalog, expands every variation, and reads Shopify product JSON. All three use the same catalog-scope gate: only a fully exhausted brand catalog is `full`; product/search/truncated runs are `partial` and cannot delist absent listings.

Only the Windows capture stage uses `crawl-products`. Processing is fixed workflow code and does not load the Skill. Both routes submit normalized observations through Jakarta Product Server's `ingestObservationBatch`, read them back with `verifyObservationBatch`, and only then close the run with `completeCrawlRun`. `PRODUCT_DATABASE_URL` remains read-only for the existing health-function vocabulary and brand-to-domain lookup; all product mutations use `PRODUCT_SERVER_URL`.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm check-types
pnpm test
pnpm build
```

## Deployment

The control plane is deployment-location independent: every worker talks only to its configured `CONTROL_PLANE_URL`. It may run from the root `Dockerfile` on Railway, or directly on a Mac mini host through `scripts/mac/start-local-control-plane.sh` and `scripts/mac/com.supplysmart.crawl-control-plane-local.plist`. The Mac launch script defaults to port `8791` and an isolated `crawl_control_plane_local` database; host workers use `http://127.0.0.1:8791`, while LAN browsers use `http://<mac-ip>:8791`. Moving the control plane later requires changing the endpoint, not the worker or adapter workflow.

Run `scripts/mac/start-worker.sh` on the Mac host so Codex, Chrome CDP, the OCR endpoint, and the product database are reachable. The dedicated GNC launcher defaults to the local control plane and can be redirected with `GNC_CONTROL_PLANE_URL`. On Windows, copy `apps/browser-node/.env.example` to `.env` and run `apps/browser-node/scripts/start.ps1`.

The Mac worker defaults to two total jobs, two global Codex calls, and four concurrent OCR image requests. Configure `PRODUCT_SERVER_URL`, the read-only `PRODUCT_DATABASE_URL`, and `OCR_ENDPOINT` in `.env.mac-worker`. `PRODUCT_SERVER_URL` may point directly at the internal Product Server, or at the public biz-server `/database` gateway together with `PRODUCT_SERVER_API_KEY`. When `CHROME_CDP_URL` is unset, the worker starts and owns a visible Chrome with a persistent profile; set it only to attach to an already running real Chrome.

Cloud and Mac artifacts are deleted only by the cleanup Job after ingestion read-back succeeds and no review remains open. `needs_review` artifacts remain available until resolution.

### Proxy routing safety

Automation may add a domain rule or change which existing proxy group a domain rule targets. It must never change the selected node inside any proxy group, including `AI/X专用` and `🔁德州前置`; node selection is a manual operator-only action. Proxy checks may read the current group and node, but must not call the controller API or edit configuration to select, reorder, add, or remove nodes unless the operator explicitly authorizes that exact node change.

## Windows Browser Node

The Browser Node can keep the existing one-shot runner (`CODEX_RUNNER=exec`) or use a long-lived local App Server (`CODEX_RUNNER=app-server`). Each concurrency Lane owns a separate Chrome profile/CDP endpoint and a separate Codex runner, so two Jobs never share tabs or browser state. App Server is spawned as a child process over `stdio`; it is not exposed over the network. Each control-plane Job is mapped to a persisted Codex Thread in the Browser Node SQLite database, so retries resume the same conversation. Turn events are appended to the Job's `codex-events.jsonl` file.

Chrome is owned by the Browser Node, not inherited from Codex Desktop. At startup every Lane must connect over localhost CDP, open a test page, execute JavaScript, and capture a screenshot before the node registers or claims a Railway Job. A failed Lane stays out of the advertised concurrency.

Before starting the local prototype, make sure `codex` is installed and signed in, then configure:

```sh
CODEX_RUNNER=app-server
CODEX_SKILL_PATH=/absolute/path/to/crawl-products/SKILL.md
NODE_CONCURRENCY=2
CHROME_HEADLESS=false
CHROME_PROFILE_ROOT=/absolute/path/to/chrome-profiles
```

Keep `CODEX_UNATTENDED_FULL_ACCESS=false` for the first tests. The App Server runner uses Codex auto-review with a workspace-write sandbox and grants write access only to the repository and current Job directory. Switch back to `CODEX_RUNNER=exec` without changing the queue or artifact workflow.

Run a real local login/model/stdio smoke test with:

```sh
pnpm --filter @crawl-automation/browser-node smoke:app-server
```

The command prints the persisted Thread/Turn ids and the temporary directory containing `result.json` plus `events.jsonl`.

Validate the actual Chrome/CDP adapter before starting the queue worker:

```sh
pnpm --filter @crawl-automation/browser-node smoke:browser -- --url https://www.motherspromise.com
```

This command starts the same isolated Chrome used by a Worker Lane, connects through the Skill adapter, navigates, executes JavaScript, captures a screenshot, prints a credential-free result, and shuts Chrome down. It does not claim a Job.

Run one real site through the Browser Node capture prompt without claiming a Railway Job:

```sh
pnpm --filter @crawl-automation/browser-node capture:local -- --url https://example.com
```

The command creates an ignored `.automation-runs/local/<site>-<timestamp>` directory. Resume an interrupted run with `--job-directory <that-directory>`; the script reloads its persisted App Server Thread id.
