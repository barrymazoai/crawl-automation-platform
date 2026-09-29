# Crawler V3 architecture

Diagrams and worked examples: https://claude.ai/artifact/V2BEtrMS53dgZWSaJnXpFg
Restructure plan and phase status: see "Migration status" at the end of this file.

## Layers

A layer imports only the layers below it. Channels and processing sit side by side and never import each other.
`pnpm check:deps` enforces this (`.dependency-cruiser.cjs`).

| Layer | Folder | Job | Never |
|---|---|---|---|
| Interface | `apps/api` | tRPC routers on a Hono server. Check input with zod, call one service method, return the result. The only way into the system. No authentication. | Business rules, SQL, Temporal calls |
| Client | `apps/cli` | Typed command-line client of the API. | Anything the API does not do |
| Worker host | `apps/worker` | Starts the worker roles named in the machine's config. | Business rules |
| Adapters | `packages/adapters` | Implements the application's interfaces with Postgres (repositories), Temporal (start, inspect, cancel) and status files. | Business rules |
| Application | `packages/app` | One service per area: Brand, Run, Queue, Product, Review, Resource, Fleet, plus the interfaces (ports) it needs. Decides whether an operation is allowed and in which order things happen. | SQL, Temporal calls, HTTP, any website's details |
| Workflows | `packages/workflows` | Temporal workflows for every channel: Collection, Catalog, Product, Label, ResourceGate. | Reading HTML, a site's URL formats |
| Channels | `packages/channels/<channel>` | Everything specific to one website: brand lookup, product list, page parsing, facts text, identity. One folder per channel; `core/` holds the `ChannelAdapter` interface, the capture strategies and the shared pipeline steps. | Database, Temporal, permits, other channels |
| Processing | `packages/processing` | Turns label images and page text into a formula: image preparation, OCR client, text model, vision model, PDF, assembly. | Knowing the channel, fetching pages |
| Platform | `packages/platform` | Shared tools: config, logger, database connection, Temporal client, R2 storage, fetch (ScraperAPI, Ego), error registry, `createWorker`. | Brands, products, runs, channels |

`packages/v3-contracts` (data shapes) and `database/v3` (migrations) are kept and used by every layer.

## Runs

The API's `runs.submit` accepts one product URL, a list of URLs, or a whole brand on one channel.
Every run moves through: accepted → waiting for permit → running → completed / failed / cancelled → settled.
Settled means its permits and its source guard are released. Stopping a run is `runs.cancel`; nothing is repaired
by script.

## Resources

A resource is anything limited: a browser space, the ScraperAPI lane, the model account, OCR, CPU. Every resource has
a kind (`browser`, `http-lane`, `model`, `ocr`, `cpu`). A permit is one unit of a resource. The capture strategy
decides which kind a step needs; a config that pairs HTTP capture with a browser permit is refused at startup.

## Machines

| Machine | Runs |
|---|---|
| Server 一 (Mac mini, US) | API, workflow and channel workers, text and vision model workers, Ego browser, health monitor, Postgres. Holds the ScraperAPI key. |
| Server 二 (Mac mini) | Temporal (Docker), Ego browser, brand certification tool. |
| Windows | The OCR service only. |

Both Mac minis have an Ego browser; each browser space is its own resource, and a run takes whichever is free.
Every service is started by hand; nothing starts at boot or login. Code reaches a server only through git.

## Design patterns

- Layered architecture with ports and adapters: logic depends on interfaces; databases and websites plug in.
- Adapter + registry: one `ChannelAdapter` per website, looked up by channel id.
- Strategy: capture (browser or HTTP); formula source (facts text or OCR).
- Template method: the shared product pipeline with channel hooks.
- Repository: all SQL lives in repository classes in `packages/adapters`.
- Facade: application services are the API's only door into the system.
- State machine: the run lifecycle, with one settle step for every ending.
- Composition root: one awilix container per app builds and wires every part.

## Migration status

| Phase | Content | Status |
|---|---|---|
| 1 | Guardrails: ESLint, Prettier, dependency-cruiser, jscpd, lefthook, CI, `test:v3` | Done |
| 2 | `packages/platform`: config, logger, database, Temporal client, error registry. Storage and fetch move in with the channels in phase 5. | Done |
| 3 | `packages/app` + `packages/adapters` + `apps/api` (tRPC on Hono) + `apps/cli`: runs, queue, brands, reviews, products, resources and permits, fleet, delivery runner. In production on Server 一 since 2026-09-29 as job `collection-api` (release `api-bb2e622`, port 4188). | Done |
| 4 | Run lifecycle: cancel, permit and guard release on every ending, resource kinds | Done |
| 5 | Channel interface; Swanson, then Amazon, GNC, DTC; Costco and Whole Foods | 5.1–5.3 done: `packages/channels/core` + Swanson adapter, shared `ProductPipelineWorkflow` (`packages/workflows`), pipeline worker (`apps/worker`), product runs through the API; live on Server 一 since 2026-09-29 |
| 5M | Label processing merge: the per-channel copies of label processing (Swanson/DTC, Amazon, GNC) become one, in `packages/processing` (plan file, "Label processing merge" M1–M8) | M1 done: the text step (quote placement, label and anchored protocols, results, receipt, Codex text client) in `processing/src/text`; `v3-text` is a facade over it. Intended change: a local-store failure now records its own `STORAGE.*` code in the Review (was `TEXT.OUTPUT_LIMIT` / `TEXT.LOCAL_CONFIG`). M2 done: one result store (`processing/src/results`), one step template and one receipt template (`processing/src/step`) used by text and OCR; the OCR step, OCR receipt and the OCR API client (generated from the API's OpenAPI document with openapi-typescript, called with openapi-fetch) in `processing/src/ocr`; keyword screening in `processing/src/keywords`; image OCR task preparation in `processing/src/images`; one `processing_result` repository in `adapters/postgres`. R2 keys and stored records are unchanged. Intended changes: a lost or failed ledger write is settled by reading it back (text: `TEXT.HANDOFF_UNKNOWN` instead of `TEXT.UNCLASSIFIED`; OCR: success when the read-back finds it); a damaged journal is an integrity failure; an unreachable Review ledger is `*.REVIEW_UNKNOWN`; the OCR journal is kept in the worker's local store (`ocr-completions/`) instead of a separate folder. M3 done: one Codex client for text and vision (`processing/src/codex`, on the existing `v3-codex` app-server client — owner decision, not the Codex SDK); vision step, receipt, results and decoders in `processing/src/vision` (one copy instead of three). M4 done: `processing/src/{pages,label,assembly,pdf,publication}`; label-core readers are channel adapter hooks (`channels/swanson`, `channels/gnc`); one label plan for every channel; one `collected_product` repository. Intended changes: Swanson label-core read-back is the strict comparison; GNC label inputs use `v3/channel-labels/` and `CHANNEL.LABEL_*`; legacy image-only and mixed assembly not ported. M7 done: `reviews.recheck` and `reviews.evidence` (raw evidence over the API, owner decision), CLI review commands, read-only R2 in the API, page text on html-to-text (Swanson switched), run ID on every worker log line. Queue: one product queue for every channel (`queue_*` tables, dispatcher in the API process; Amazon keeps its tables until 5.5). Fetch: the ScraperAPI client is in `platform/src/fetch` on undici, with per-channel render/premium/country options and the credit cost recorded; product capture is ScraperAPI only (the browser is used only for Amazon Store pages and Whole Foods, in brand scanning). Listing state: a product page that is gone or redirects to another product is recorded as `unlisted` with its reason (not a Review), every channel (028). Formula reuse: channel + listing + variant; Amazon and Whole Foods share formulas by ASIN; size/pack siblings reuse a formula after a label check against the page's facts text (029, behind `patched("formula-reuse-v1")`). GNC adapter (ScraperAPI, facts table, metrics, families); brand scans as API procedures for Swanson, GNC and Whole Foods (030) — every listed product queued, full scans request revisits of missing known listings; brand-source import. Whole Foods channel: Ego browser pages via Ego's own SDK (store 10259, every metrics row records the store) |
| 6 | Grouped worker processes, generated job list, one deploy command, old scripts archived | |

Code outside the new folders (`apps/v3-*`, `packages/v3-*`) keeps running in production until its replacement is
verified, then moves or is archived.
