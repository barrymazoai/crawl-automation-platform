# Crawl Automation Platform

This monorepo is the deterministic controller for distributed product crawling.

- `apps/web`: Mac mini operations console (Vite, React, TanStack Router/Query, Ant Design, AG Grid, Tailwind).
- `apps/backend`: Railway control plane plus the Mac processing worker entry point.
- `apps/browser-node`: Windows Codex + programmable Chrome worker.
- `packages/contracts`: versioned `EvidenceBundleV1`, Job, Node, and typed oRPC contracts.
- `packages/runtime`: leases, node client, local SQLite checkpoint/outbox, Codex runner, and artifact helpers.
- `packages/ocr-client`: Link Monitor-compatible multipart OCR client (15 second timeout, one retry).
- `crawl-products`: the in-repository Codex Skill and deterministic crawl helpers.

The control plane owns the finite Job DAG `capture -> ocr -> normalize -> ingest -> cleanup`. Railway stores queue/lease metadata and object references only. Browser work runs on Windows; OCR, semantic normalization, validation, and ingestion run on the Mac mini.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm check-types
pnpm test
pnpm build
```

## Deployment

Deploy the root `Dockerfile` as the Railway control plane. On the Mac mini, `.env.mac` configures the LAN-only proxy console and `compose.mac.yml` exposes it on port 8787. Run `scripts/mac/start-worker.sh` on the host so Codex and the existing Supply Smart database remain locally accessible. On Windows, copy `apps/browser-node/.env.example` to `.env` and run `apps/browser-node/scripts/start.ps1`.

Cloud and Mac artifacts are deleted only by the cleanup Job after ingestion read-back succeeds and no review remains open. `needs_review` artifacts remain available until resolution.
