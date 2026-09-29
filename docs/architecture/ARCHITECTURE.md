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
| Application | `packages/app` | One service per area: Brand, Run, Queue, Product, Review, Resource, Fleet. Decides whether an operation is allowed and in which order things happen. | HTTP, any website's details |
| Workflows | `packages/workflows` | Temporal workflows for every channel: Collection, Catalog, Product, Label, ResourceGate. | Reading HTML, a site's URL formats |
| Channels | `packages/channels/<channel>` | Everything specific to one website: brand lookup, product list, page parsing, facts text, identity. One folder per channel; `core/` holds the `ChannelAdapter` interface, the capture strategies and the shared pipeline steps. | Database, Temporal, permits, other channels |
| Processing | `packages/processing` | Turns label images and page text into a formula: image preparation, OCR client, text model, vision model, PDF, assembly. | Knowing the channel, fetching pages |
| Platform | `packages/platform` | Shared tools: config, logger, database and repositories, Temporal client, R2 storage, fetch (ScraperAPI, Ego), error registry, `createWorker`. | Brands, products, runs, channels |

`packages/v3-contracts` (data shapes) and `database/v3` (migrations) are kept and used by every layer.

## Runs

`POST` through the API's `runs.submit` accepts one product URL, a list of URLs, or a whole brand on one channel.
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
- Repository: all SQL lives in repository classes.
- Facade: application services are the API's only door into the system.
- State machine: the run lifecycle, with one settle step for every ending.
- Composition root: one awilix container per app builds and wires every part.

## Migration status

| Phase | Content | Status |
|---|---|---|
| 1 | Guardrails: ESLint, Prettier, dependency-cruiser, jscpd, lefthook, CI, `test:v3` | Done |
| 2 | `packages/platform`: config, logger, database, Temporal client, error registry. Storage and fetch move in with the channels in phase 5. | Done |
| 3 | `packages/app` + `apps/api` (tRPC on Hono) + `apps/cli` | Next |
| 4 | Run lifecycle: cancel, permit and guard release on every ending, resource kinds | |
| 5 | Channel interface; Swanson, then Amazon, GNC, DTC; Costco and Whole Foods | |
| 6 | Grouped worker processes, generated job list, one deploy command, old scripts archived | |

Code outside the new folders (`apps/v3-*`, `packages/v3-*`) keeps running in production until its replacement is
verified, then moves or is archived.
