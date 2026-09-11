# V3 channel adapters

2026-09-07 closeout: `GncCatalogDiscoveries` publishes one verified catalog entry at a time, independently of the browser and downstream processing. Independent discovery/page-Workflow roles, immutable per-entry evidence and cold readback are described in [the closeout report](../../docs/quality/2026-09-07-gnc-discovery-closeout.md). Later failures never retract earlier entries. Brand traversal/sealing stays in task36. Historical pending statements below are superseded only where explicitly covered by the later reports.

2026-09-07: [GNC product preparation and file access](../../apps/v3-workers/GNC_PRODUCT.md) turn verified capture into a SKU-scoped page plus independent file/OCR plans. `GncFileSources` resolves exact per-file URLs from retained evidence using private product grants, origin-scoped headers and a matching route; the independent `gnc-file` role supports direct/static-proxy without fallback. Local CONNECT/TLS + Temporal integration passed; deployment, live-site verification and Web/API grant distribution remain pending.

Current implementation: GNC catalog-page and single-SKU evidence extraction, durable handoff and receipt-only verification. Independent [GNC Worker/Temporal roles](../../apps/v3-workers/GNC_WORKER.md) are now registered and locally integration-tested, **not deployed**.

2026-09-07 persistence: `AcquireGncModule` + `GncCaptureEvidence` now retain original HTML before parsing, publish immutable source/parsed/completion artifacts via the existing R2 ObjectStore, and reconcile uncertain handoff without recrawling. `GncAcquireInput` explicitly binds Observation and network selection. `inspect` is read-only; `resume` may publish only never-attempted retained outputs and cannot crawl/parse. Passive Review remains passive. [Implementation and real R2 acceptance](../../docs/quality/2026-09-07-gnc-handoff.md). The bare `GncAdapter` still returns `artifactDurable:false`; only the persistence wrapper can return a verified durable receipt. The receipt is not product collection or Temporal delivery.

2026-09-07: `GncHttpReader` now supplies a concrete bounded raw-HTTP path through an injected `HttpRoute`; see [network configuration](../v3-acquisition/NETWORK.md) and [network test report](../../docs/quality/2026-09-07-gnc-network.md). Construct `new GncAdapter(new GncHttpReader(route, privateExactRequestGrants))`. Grants include exact input, expiry and optional origin headers; store them privately. The reader caps streaming bytes/time, validates public DNS and binding, and refuses redirects. Browser/rendered HTML, physical exit verification and reliable R2 handoff remain pending. The original core-only descriptions below are historical where they say no reader implementation exists.

## Boundaries

- `GncAdapter` receives a `GncPageReader` through constructor injection. Each capture performs one read. A production reader must enforce authorized URLs, response byte limits while reading, DNS/redirect policy, source/session/egress leases and cancellation. No concrete network provider is selected in this package yet.
- Shared input/output schemas live in `v3-contracts`. Input retains request, operation, Brand, source and session/egress identifiers. Reader responses must match the request and binding. Redirects currently fail closed, including same-origin redirects.
- Catalog calls handle one page, return SKU/family candidates and an explicit next URL. No next control means `unverified_end`, **not** proof of a complete Brand. Empty or contradictory pages raise classified errors. Family URLs still need a separate expansion step; no family-to-SKU guessing.
- Product calls require exact six-digit SKU JSON-LD. Unrelated recommendations cannot become variants; only the matching ProductGroup and explicit variation controls supply variant candidates. No fallback to the first Product object.
- Keep original HTML bytes/hash and exact Ingredients/Details DOM fragments, including incomplete tables. No Formula/Ingredients eligibility judgment or legacy company matching occurs here.
- Image URLs are candidates only (`verifiedOriginal: false`), not downloaded assets. No upscale guesses, PDF extraction, OCR or Codex calls. Browser gallery review/downloader validation remains required.
- Limits fail explicitly rather than truncate. Captcha script names alone do not imply access denial. HTTP/challenge/SKU/pagination/encoding errors have stable `GNC.*` codes; network port errors propagate. Future activity integration must persist these into passive Review.
- `artifactDurable: false` is intentional. Returning bytes is **not** reliable handoff, R2 persistence, downstream workflow submission or a collected product. The next integration must bind an Observation/listing/variant, save immutable artifacts, and recover from delivery evidence without silently repeating acquisition.

## Verification

`pnpm --filter @crawl-automation/v3-channels test`

`pnpm --filter @crawl-automation/v3-channels --filter @crawl-automation/v3-contracts build`

Fixtures are synthetic and offline. Legacy selectors are migration hypotheses, not proof of current live GNC compatibility. No complete Brand crawl, network rotation, paid request, R2 write or deployment is performed by these tests.

## Legacy reference audit

- `apps/backend/src/gnc/capture.ts`: reuse observed product tile, load-more and accordion selectors as hypotheses; do not copy whole-Brand batching, script execution, truncation, automatic retries or PDF discovery.
- `apps/backend/src/gnc/extract.ts`: exact SKU association retained, unsafe first-product fallback removed.
- `apps/backend/src/gnc/scraperapi-page.ts`: visible-content challenge check retained conceptually; key switching/retry loops and `new Function` DOM execution not imported.
- `apps/backend/src/v2/swanson-capture.ts`: old comment records dropping already captured facts at publication. New GNC core returns raw fragments even when incomplete. Swanson implementation remains a separate task.
