# GNC capture → page / image processing → collected product

2026-09-07 · local isolated implementation, not deployed or live-site quality acceptance. PDF remains paused.

## What runs where

`GncProductWorkflow` runs on the new `gnc-product-workflow` role (`v3.gnc.product.workflow.v1.gnc-product-v1`). It starts the existing capture-only child, then schedules `prepareGncProduct` on an independently started **gnc-product-input** role (`v3.gnc.product-input.v1.gnc-input-v1`). Preparation has storage/Review dependencies but no network reader, OCR or model.

After verification, a `SavedProductWorkflow` child owns this product's independent source branches:

```
GNC single-SKU capture → receipt verified → product-input plan persisted
                                           ├─ page → page.prepare → text-input → Codex text → receipt
                                           ├─ image 0 → file.acquire → OCR-input → OCR → keywords → matched: Codex vision
                                           └─ image 1 → file.acquire → OCR-input → OCR → keywords → not_matched
                                                          all source states → assembly → eligible: collection
```

Each arrow crossing a module is a queued Activity, not a direct function call inside the capture Worker. Source branches start together; slow/missing file Workers do not block page processing. Only the final assembly waits for all source terminal states. Capture/plan Activities and child Workflow retries are limited to one attempt. Repeated business operations reuse retained evidence; they are not fresh crawl requests.

## Evidence and eligibility

`GncProductPlans` first verifies the original HTML, parsed evidence, owner, capture nonce and source hash. It creates a separate HTML artifact containing the existing SKU-scoped facts/details DOM fragments, **not the full page containing recommendations**. The full original page is retained upstream. The immutable plan binds input profiles, capture record, fragment and complete page/image source manifest at `v3/gnc-products/<product-operation>/plan.json`.

Each candidate image produces its own `FileOcrPlan` with stable opaque resource/operation identities and inherited source session/egress. No candidate is silently dropped, rewritten to a guessed high-resolution URL or declared a verified original. Over 100 total sources fails explicitly, so 100 images plus a page is an error, not truncation. Empty page fragments allow an image-only plan; no usable page or image becomes `GNC.NO_PRODUCT_SOURCES`.

Plans store exact model/OCR compatibility fingerprints. Prepared output and input model settings are checked before child processing. Changed owner/config/plan or damaged fragment cannot silently reuse a prior product. Plan publication uses existing local/shared one-shot markers; unknown upload is not blindly retried. Preparation errors use a separate stable passive `gnc.product-input` Review, not the capture operation's Review identity.

All GNC sources are **optional evidence contributors**: one source failure alone is not an extra product eligibility condition. Formula + Ingredients must still be supported by valid completed evidence. Failed sources stay in the manifest/Review and warnings; successful OCR with no keywords skips vision and remains `SCREEN.NO_KEYWORDS`. Explicit protocol/identity corruption is not excused by optional status. Final assembly/collection re-verifies file bytes, acquisition completion, published OCR-input plan, OCR/keyword evidence and contributing model records.

## New source / queue versions

Shared contracts now include `SavedEvidenceSource.kind = "file-image"` with `{ id, required, plan: FileOcrPlan, visionOperationId, configFingerprint }`. Unlike `ocr-image`, its file is not downloaded yet. It requires `queues.acquire` and `queues.imagePrepare`. Independent file / OCR preparation happens before the existing OCR → keywords → vision branch.

Use **saved-product-v3** (`v3.product.saved.workflow.v1.saved-product-v3`) and **mixed-product-v5** assembly/collection roles. Old capture-only and pure-image queues do not change. Do not replace artifacts for running old compatible queues or route new source kinds to v2/v4 consumers. No database migration is required; collection remains `collected-product/2`.

New GNC roles use the existing dedicated `build:gnc`, `worker:gnc`, `worker:gnc-workflow` entries and runtime config. The product-input private config has the same storage/Review shape as `gnc-receipt`, with role `gnc-product-input`; network/grants are forbidden. `--list` now exposes 5 GNC Activity roles (including `gnc-file`) and 2 Workflow roles. Product child/assembly Workers remain separately deployed entries, not hidden inside GNC.

Input structure:

```ts
{
  input: {
    operationId: "new-product-operation",
    task: exactGncAcquireInputForOneSku,
    text: textCompatibilityV2,
    ocr: ocrCompatibilityV2,
    visionConfigFingerprint
  },
  queues: { page, pageText, text, textReceipts, acquire, imagePrepare,
    ocr, ocrReceipts, keywords, vision, assembly, collection }
}
```

No raw image download URL, cookie, proxy credential or local file path is in this processing manifest. New operation/observation identities are needed for an intentional fresh collection. A collection receipt refers to the V3 captured-product snapshot, not synchronization to the old/formal product service.

## File network authorization boundary

### Explicit saved-HTML reparse

For a **new** product operation, `GncProductInput.parseVersion: "gnc-product-html/2"` selects the updated parser over verified captured HTML. Omit it to preserve the original capture-result semantics. The preparation module publishes separate parser/source-provenance evidence plus the new plan; no browser request or capture completion replacement occurs. File URL resolution follows the selected version. Never change the version on an already published operation, or mutate parser `/2` semantics for future fixes. This path requires updated consumers; it has not been deployed to live Temporal queues. See [real-gallery acceptance](../../docs/quality/2026-09-07-gnc-gallery-reparse.md).

Per-URL credential grants may expire earlier than the outer grant because of Cookie expiry. Provision close to file execution; queue delay can correctly reject an otherwise valid plan. There is no automatic refresh/retry. A deliberate new attempt must retain old failures and use new operation identities; existing durable files remain readable without live credentials.

Use independent **`gnc-file`**, capability `gnc.file`, compatibility `gnc-file-v1`, queue `v3.gnc.file.v1.gnc-file-v1`, Activity `acquireSourceFile`. Set `queues.acquire = GNC_PRODUCT_QUEUES.files`; do not redirect unrelated consumers to this queue. The role composes `GncFileSources` with generic `AcquireFileModule` and `FileEvidence`; it never captures pages, prepares plans, calls OCR or waits for downstream processing. Runtime concurrency applies per file. Build/start it using the same GNC entry, separate runtime and private configuration.

Private config shape (placeholders; never send this to Temporal):

```ts
{
  role: "gnc-file",
  journalRoot: "/absolute/private/file/journal",
  cacheRoot: "/absolute/private/file/cache",
  r2, r2Credentials, reviewDatabase, // storage/Review shapes in GNC_WORKER.md
  network: exactCaptureNetworkRoute,
  proxyUrl: "http://127.0.0.1:7890", // static-proxy only; omit for explicit direct
  fileGrants: [{
    input: exactGncProductInput,
    allowedOrigins: ["https://www.gnc.com"], // only approved, verified CDN origins
    expiresAt: "<future ISO timestamp>",
    headersByOrigin: { "https://www.gnc.com": { cookie: "<optional private credential>" } }
  }]
}
```

The operator authorizes a product plan once, not every image URL. For each file, `GncProductPlans.fileSource` re-verifies the retained capture and full plan, matches the **entire** FileAcquireInput, then resolves that one original candidate URL read-only. No URL rewriting or source upload. Independent leases mean a blocked image origin does not invalidate another image. Limits: ≤1000 grants, one plan per observation per process; explicit public HTTPS origins, exact owner/session/egress and full route metadata; expiry checked before/after lookup and throughout network processing.

`direct` and `static-proxy` use existing route adapters. A fixed Clash HTTP/mixed port may be supplied as proxy endpoint; this does not configure groups, rotate nodes or attest actual public IP. No environment-proxy fallback or global network mutation. `host` startup remains rejected until an owning runtime client is implemented. Capture/file workers must have consistent route definitions; metadata is an operator assertion, not IP attestation. R2 connectivity is separate from source-site routing.

Headers are keyed by exact origin. Credentials never propagate across an origin redirect, even to another allowed CDN; proxy authentication is used only for CONNECT. Private URL/headers/proxy config do not enter file Activity inputs. Missing/expired/mismatched grants block new downloads and enter passive file Review, with no automatic retry. Existing verified completed files can be reused read-only after grant expiry: expiry revokes new network access, not retained evidence. Unknown earlier execution never authorizes another download.

The old `directFileSources` export and `StaticDirectSources` Worker remain direct-only. The new role removes manual per-image catalog generation, but Web/API product-grant distribution, dynamic updates/revocation and browser-owned sessions remain pending. Current config is a private deployment snapshot, not a live configuration service.

## Verification and next

Run `pnpm --filter @crawl-automation/v3-workers test:gnc` and `pnpm --filter @crawl-automation/v3-channels test`. [Latest file/network acceptance](../../docs/quality/2026-09-07-gnc-files.md); [earlier product-chain acceptance](../../docs/quality/2026-09-07-gnc-product-chain.md).

Proxy file acquisition now sends hostname CONNECT without client target DNS, matching the page reader. Direct still pins public addresses. Proxy destination-address restrictions belong to the trusted proxy; configure a new route version for the changed policy. A shared Clash endpoint alone does not prove fixed exit/session isolation. See [network policy](../../packages/v3-acquisition/NETWORK.md).

Next: bounded approved GNC page/image validation; incremental Brand/family discovery and UI/API entry/grant distribution remain pending. Integration now uses a built independent file Worker with real CONNECT/TLS against a local synthetic origin, not synthetic SourceAccess. Models/storage remain fixtures. No whole-Brand run, true image quality, live model quality, production schema/deployment, browser/Clash control or Swanson completion is claimed.
