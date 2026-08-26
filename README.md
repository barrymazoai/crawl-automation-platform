# Crawl Automation Platform

This monorepo is the deterministic controller for distributed product crawling.

- `apps/web`: Mac mini operations console (Vite, React, TanStack Router/Query, Ant Design, AG Grid, Tailwind).
- `apps/backend`: Railway control plane plus the Mac processing worker and the migrated Link Monitor Amazon adapter.
- `apps/browser-node`: Windows Codex + programmable Chrome worker.
- `packages/contracts`: versioned `EvidenceBundleV1`, Job, Node, and typed oRPC contracts.
- `packages/runtime`: leases, node client, local SQLite checkpoint/outbox, switchable Codex exec/App Server runners, and artifact helpers.
- `packages/ocr-client`: stateless multipart OCR API client.
- `crawl-products`: the in-repository Codex Skill and deterministic crawl helpers.

The control plane owns two finite DAGs:

- DTC: `capture (Windows Browser + crawl-products Skill) -> process (Mac OCR + Codex) -> ingest (Jakarta API) -> cleanup`
- Amazon: `process (Mac fixed adapter + OCR + Codex + Jakarta API) -> cleanup`

There is no standalone OCR Job and no OCRBundle. DTC EvidenceBundle archives cross from Windows to the Mac through object storage; the Mac expands them once, calls the OCR API for all images with bounded concurrency, and processes the OCR sidecars locally. Amazon never uploads an EvidenceBundle: its fixed adapter uses the Mac Chrome CDP connection, saves resumable local Brotli snapshots, expands every explicit variation into an independent listing, performs deterministic Link Monitor extraction, then runs semantic and label-text processing.

Only the Windows capture stage uses `crawl-products`. Processing is fixed workflow code and does not load the Skill. Both routes write through Jakarta `product/enrich`, submit label rows through `product/submitFacts`, and verify each returned product with `product/getById` before cleanup is allowed.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm check-types
pnpm test
pnpm build
```

## Deployment

Deploy the root `Dockerfile` as the Railway control plane. On the Mac mini, `.env.mac` configures the LAN-only proxy console and `compose.mac.yml` exposes it on port 8787. Run `scripts/mac/start-worker.sh` on the host so Codex, Chrome CDP, the OCR endpoint, and the Jakarta product API are reachable. On Windows, copy `apps/browser-node/.env.example` to `.env` and run `apps/browser-node/scripts/start.ps1`.

The Mac worker defaults to two total jobs, two global Codex calls, and four concurrent OCR image requests. Configure `SUPPLY_SMART_API_URL`, `OCR_ENDPOINT`, and `CHROME_CDP_URL` in `.env.mac-worker`; `PRODUCT_DATABASE_URL` is no longer used.

Cloud and Mac artifacts are deleted only by the cleanup Job after ingestion read-back succeeds and no review remains open. `needs_review` artifacts remain available until resolution.

## Local App Server prototype

The Browser Node can keep the existing one-shot runner (`CODEX_RUNNER=exec`) or use a long-lived local App Server (`CODEX_RUNNER=app-server`). App Server is spawned as a child process over `stdio`; it is not exposed over the network. Each control-plane Job is mapped to a persisted Codex Thread in the Browser Node SQLite database, so retries resume the same conversation. Turn events are appended to the Job's `codex-events.jsonl` file.

Before starting the local prototype, make sure `codex` is installed and signed in, then configure:

```sh
CODEX_RUNNER=app-server
CODEX_SKILL_PATH=/absolute/path/to/crawl-products/SKILL.md
NODE_CONCURRENCY=2
```

Keep `CODEX_UNATTENDED_FULL_ACCESS=false` for the first tests. The App Server runner uses Codex auto-review with a workspace-write sandbox and grants write access only to the repository and current Job directory. Switch back to `CODEX_RUNNER=exec` without changing the queue or artifact workflow.

Run a real local login/model/stdio smoke test with:

```sh
pnpm --filter @crawl-automation/browser-node smoke:app-server
```

The command prints the persisted Thread/Turn ids and the temporary directory containing `result.json` plus `events.jsonl`.

Run one real site through the Browser Node capture prompt without claiming a Railway Job:

```sh
pnpm --filter @crawl-automation/browser-node capture:local -- --url https://example.com
```

The command creates an ignored `.automation-runs/local/<site>-<timestamp>` directory. Resume an interrupted run with `--job-directory <that-directory>`; the script reloads its persisted App Server Thread id.
