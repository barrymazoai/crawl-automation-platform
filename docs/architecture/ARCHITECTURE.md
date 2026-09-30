# Crawler V3 architecture

Diagrams and worked examples: https://claude.ai/artifact/V2BEtrMS53dgZWSaJnXpFg
Restructure plan and phase status: see "Migration status" at the end of this file.

## Layers

A layer imports only the layers below it. Channels and processing sit side by side and never import each other.
`pnpm check:deps` enforces this (`.dependency-cruiser.cjs`).

| Layer | Folder | Job | Never |
|---|---|---|---|
| Interface | `apps/api` | tRPC routers on a Hono server. Check input with zod, call one service method, return the result. The only way into the system: every operation is an API procedure, there is no CLI (owner 2026-09-30). No authentication. | Business rules, SQL, Temporal calls |
| Worker host | `apps/worker` | Starts the worker roles named in the machine's config. | Business rules |
| Adapters | `packages/adapters` | Implements the application's interfaces with Postgres (repositories), Temporal (start, inspect, cancel) and status files. | Business rules |
| Application | `packages/app` | One service per area: Brand, Run, Queue, Product, Review, Resource, Fleet, plus the interfaces (ports) it needs. Decides whether an operation is allowed and in which order things happen. | SQL, Temporal calls, HTTP, any website's details |
| Workflows | `packages/workflows` | Collection, ProductPipeline, Label and BrowserScan workflows; ResourceGate manages permits. | Reading HTML, a site's URL formats |
| Channels | `packages/channels/<channel>` | Everything specific to one website: brand lookup, product list, page parsing, facts text, identity. One folder per channel; `core/` holds the `ChannelAdapter` interface, the capture strategies and the shared pipeline steps. | Database, Temporal, permits, other channels |
| Processing | `packages/processing` | Turns label images and page text into a formula: image preparation, OCR client, text model, vision model, assembly. | Knowing the channel, fetching pages |
| Platform | `packages/platform` | Shared tools: config, logger, database connection, Temporal client, R2 storage, fetch (ScraperAPI, Ego), error registry, `createWorker`. | Brands, products, runs, channels |

`packages/v3-contracts` (data shapes) and `database/v3` (migrations) are kept and used by every layer.

## Runs

The API's `runs.submit` accepts one product URL, a list of URLs, or a whole brand on one channel.
Every run moves through: accepted → waiting for permit → running → completed / failed / cancelled → settled.
Settled means its permits and its source guard are released. Stopping a run is `runs.cancel`; nothing is repaired
by script.

## Resources

A resource is anything limited: a browser space, the ScraperAPI lane, the model account, OCR, CPU. Every resource has
a kind (`browser`, `http-lane`, `file-lane`, `model`, `ocr`, `cpu`). A permit is one unit of a resource. The capture strategy
decides which kind a step needs; a config that pairs HTTP capture with a browser permit is refused at startup.

## Machines

| Machine | Runs |
|---|---|
| Server 一 (Mac mini, US) | API, workflow and channel workers, text and vision model workers, browser worker, Ego browser, Postgres (Docker). Holds the ScraperAPI key. |
| Server 二 (Mac mini) | Temporal (Docker), browser worker, Ego browser, brand certification tool. |
| Windows | The OCR service only. |

Both Mac minis have an Ego browser and browser worker; each browser space is its own resource, and a run takes whichever is free.
Ego is the browser for Amazon Store-page brands and DTC. Whole Foods waits on its real-page test (R22; `24c6bae`, R36).
Postgres on Server 一 (Docker) is published on 127.0.0.1 and on the private address 192.168.68.70; Server 二 reaches it directly, no tunnel (verified 2026-09-30, R40).
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

This table records code committed through `df7466a`. Live rollout is unverified.
Saved pages and workflow histories must stay outside git (`7af5d90`, R45).

| Phase | Done in code | Left or unverified |
|---|---|---|
| 1 — Guardrails | Lint, format, layer checks, CI and V3 tests (`1a5d349`). Every error code from a registry, checked by a test; catches keep their reason (`fc2a9a1`, R34/R35). Legacy-import guard (`7f9b096`, R01). Service and workflow replay tests (`0844758`, R37; `e15bad4`, R38). | Finish the legacy-import baseline and package.json ban (R01; `9b57669` still records 16 baseline entries). |
| 2 — Platform | Config, logger, database and Temporal client (`892e306`). ScraperAPI client (`68adac2`). R2 storage (`b152884`, R02) and Codex client (`2d7e0d9`, R04). | Remaining legacy dependencies are tracked under R01. |
| 3 — Application, adapters, API | API services (`e3cb3c4`, `d7c3a26`) and startup fix (`f492c1e`). Review ledger (`6255143`, R03). Channel list, scan counts and lookups (`70bb87d`, R12/R32/R33). Amazon on the shared queue (`df7466a`, R13). HTTP `evidence.capture` archives and verifies originals in R2 (`92b0b65`, `3dd03ed`, R45). No CLI; `apps/cli` is archived (`7af5d90`, `9b57669`, R41). | Browser evidence capture and migration of remaining saved fixtures out of git (R45). |
| 4 — Lifecycle | Stop-evidence settlement (`026e215`). ResourceGate permit release (`836e8f9`, R05). Permit-kind checks (`d0204af`, `3c8022c`, R15). Activity heartbeats (`5fa2f81`, R16). Collection workflow and list submission (`04159ff`, R11). | Old histories still use the legacy gate (`836e8f9`, R05). Full runtime cutover is unverified (R05/R16). |
| 5 — Channels | Swanson and GNC adapters/scans (`31881a3`, `5cb0552`); migrated parsers (`c5bdbdb`, `6e415c0`, R07) and identity checks/GNC label wiring (`02aa420`, R23/R25). Amazon adapter (`fa4bae9`, R17), registration and search scans (`3dd03ed`, R17/R18). DTC adapter (`5e3565b`, R20). Whole Foods adapter/scans (`5cb0552`). Capture by capability (`3dd03ed`, R24). 24 h HTML reuse for HTTP capture (`96baf06`, R14). Live listing sightings (`1fe60b5`, R30). | DTC wiring and real-page coverage (R20). Whole Foods real-page test, identity and capture choice (R22). Costco adapter unverified (R21). Amazon Store-page scans in the browser (`88552af`, R19): live selectors and cancel cleanup checked on a Mac mini at deploy (R46). |
| 5M — Label merge | Shared processing and Label workflow (`e8d4ee7`, `2643306`, `68adac2`, `4c51b15`). Shared planner/helpers (`c5bdbdb`, R06; `6fe884a`, R28). OCR sibling checks (`d27f4d1`, R26). `label-text/4` only (`9dcb178`, R27). PDF removed (`a6bf7fb`, R29). Packaging and ingredient fixes (`20b14c8`, R47/R48). | Full runtime acceptance unverified (`4c51b15`); no acceptance ticket found in the messages. |
| 6 — Fleet/deploy | Grouped worker processes and Git-based deploy (`4c51b15`). Umzug migrations (`64c1db8`, R08). PM2 manual-start job control, with no automatic restart or boot/login start (`ce26dd1`, R09). Fleet status from PM2, Temporal and OCR (`a3e8cda`, R10). Browser worker on both minis (`24c6bae`, R36). Dead-file cleanup (`f1bd9fd`, R42). | Live PM2 cutover and the Amazon queue data copy (migration 034, R13) run at the deploy (R46); `ce26dd1` documents the manual steps. |

Code outside the new folders (`apps/v3-*`, `packages/v3-*`) keeps running in production until its replacement is
verified, then moves or is archived.
