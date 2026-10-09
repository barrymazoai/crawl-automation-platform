# Brand enrichment: Crawler V3 build plan

> 2026-10-09. Owner: "now you can start doing the whole thing". Design: https://claude.ai/artifact/9Br79dEuhYxtExrrsB4nPZ
> (version 6). Supply Smart side: jakarta `dev` `ce1b83a8` (SUPPLYSMAR-429), spec
> [2026-10-08-brand-enrichment-supply-smart-api.md](2026-10-08-brand-enrichment-supply-smart-api.md) revision 4.
> Test server: `http://192.168.0.34:8001` (`/rpc`, `/database/rpc`), local shadow databases, service key from the
> admin app (`:5186`).

## Rules this plan follows

- Supply Smart only through its API with a service key; the crawler never holds a Supply Smart database URL.
- Only decided results go to Supply Smart. Clues, Codex decisions, questions for a person and Apollo tries stay in
  the crawler's database (`database/v3`).
- Layers as in [ARCHITECTURE.md](../architecture/ARCHITECTURE.md); every operation is an API procedure; no CLI, no
  one-off scripts; libraries before own code; plan → build → `pnpm check` + review per phase; git-only deploy.
- New code uses `@crawl-automation/platform` for Codex and Ego, never the old `packages/v3-codex`.

## Defaults taken for the open decisions (change any of them and the plan follows)

| # | Decision | Default used |
|---|---|---|
| 2 | How Codex searches | Its own web search first; the Ego space only for pages it cites, which are saved with their hash |
| 3 | Trigger | By hand: `brandEnrichment.start({ requestId })` and `brandEnrichment.claimPending({ limit })`. Nothing polls on its own (manual-start rule) |
| 4 | Existing descriptions | `mode: "fill_empty"` |
| 5 | Group email | One email per request, sub-brands listed from `summary.family.subBrands` |
| 6 | New owners | Visible company, profile + Apollo only (owner, 2026-10-09) |

Still needed from the owner: **decision 1, the Apollo key** (where it lives and which Apollo calls may spend credits).

## Phases

### Phase 1: connections and storage (no behaviour yet)

| Piece | Layer / folder | Library | Own code, and why |
|---|---|---|---|
| Shapes of everything sent to and read from Supply Smart, Apollo and Codex | `packages/v3-contracts/src/brand-enrichment*.ts` | zod | Copied field by field from jakarta's zod schemas (we can't import jakarta packages) |
| Supply Smart client: `brandEnrichment/*`, `company/*`, `contact/*`, `product/resolveCompany` | `packages/adapters/src/supply-smart/` | `@orpc/client` `RPCLink` (already in the catalog; speaks oRPC's `{"json": …}` protocol) | Only the procedure list and the 401/403/404/409 mapping to error codes |
| Apollo client: organization search/enrich, people search | `packages/adapters/src/apollo/` | `undici` (the HTTP client the platform already uses) | Apollo has no maintained official Node SDK; a few typed calls |
| Tables: runs, clues, decisions, questions, Apollo tries, title cache | `database/v3/058_brand_enrichment.sql` | Umzug (existing runner) | Schema only |
| Repository | `packages/adapters/src/postgres/postgres-brand-enrichment-store.ts` | `pg` (existing) | SQL lives only here |
| Private config: Supply Smart base URL + service key, Apollo key | `live/` private JSON, read by `packages/platform` config | existing config loader | Two new sections |

### Phase 2: Codex tasks

New sibling of `channels` and `processing`: `packages/research` (added to the layer checks; it never imports
channels or processing). Each task = prompt + zod output schema + a check of the answer.

| Task | Runs on | Output |
|---|---|---|
| Family check | Codex in an Ego space; starts from the existing DTC site analysis links (`packages/channels/dtc/src/analysis`) | `single` / `separate_sites` / `shared_site` / `holding`, sub-brands with URL and evidence |
| Brand research | Codex (`runCodexCapture`) in its own Ego space | description, one of the five categories, keywords, ownership clues with quote + URL |
| Apollo match | Text turn per round, at most 3 rounds; code runs each Apollo search and feeds the results back | matched (with tie: domain / former_domain / linkedin / name_address), parent only, or not found |
| Reviewer | Separate text turn over all clues | owner company, no owner, or can't tell; reason citing evidence |
| Contact titles | Text turn, only titles `knownPositions` didn't answer | function + level from `contact/positionTaxonomy` |

The Apollo rounds replace "Codex calls an Apollo skill": the key never reaches Codex and the three-try cap holds by
construction.

### Phase 3: application, workflow, API

| Piece | Folder |
|---|---|
| `BrandEnrichmentService`: claim, order, limits (3 Apollo tries, 20 sub-brands, nutrition only), what counts as final, summary | `packages/app/src/brand-enrichment` |
| `BrandEnrichmentWorkflow`: identity → (DTC brand run ‖ research ‖ Apollo) → write → reviewer → close; sub-brands as child workflows; permits through the existing `resourceGate` | `packages/workflows` |
| Activities for the steps above | `apps/worker/src/activities/brand-enrichment-activities.ts` |
| Temporal start/cancel/inspect | `packages/adapters/src/temporal/` |
| API: `start`, `claimPending`, `list`, `get`, `cancel`, `questions`, `answerQuestion`, `unlink` | `apps/api/src/routers/brand-enrichment.ts` |

The DTC brand run reuses what exists: site analysis → apply → brand scan → product queue. The workflow waits until
that scan's queue items settle.

### Phase 4: products into Supply Smart

Crawler V3 does not send products to Supply Smart today. This phase maps settled DTC products to
`product/ingestObservationBatch` → `verifyObservationBatch` → `completeCrawlRun`, and formulas to
`product/ingestLabelObservation`. It gets its own plan after reading jakarta's ingest contract
(`docs/spark/2026-08-28-crawler-ingest-contract.md`), because it is shared by every channel, not only this pipeline.

### Phase 5: deploy and test

Commit to `main`, `git pull` on Server 一, migration, worker role. Server 一 must reach the test server (Tailscale
address of this MacBook, or the production API once released). First one real single brand, then one group.
