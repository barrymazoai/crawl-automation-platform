# Swanson brand listing reader

The reader first requests Constructor's `/browse/brand/<encoded name>` API using the stored
`ScanRecord.source.brandName`, with 100 cards per page. A positive `total_num_results` selects
that exact name and uses the response as page 1; the collection page is never requested.

Only an explicit zero total falls back to the collection page. Its server HTML supplies the
exact `constructor-plp[data-collection-title]` name, which the reader then uses to page
Constructor from page 1. The zero-result lookup is evidence, not a listing page. Malformed
JSON and request/archive failures stop the scan with their original error; they do not trigger
fallback or retry. A bot challenge on the fallback remains `BRAND_SCAN.ACCESS_CHALLENGE`.
Historical workflow requests without a brand name (or with a blank name) use the collection
path directly. Every request uses the existing ScraperAPI listing reader and its verified,
byte-for-byte R2 archive before parsing.

## Private configuration

In the API file named by `V3_API_CONFIG` and the scanning worker file named by
`V3_PIPELINE_CONFIG`, merge the following into the existing `brandScans` section:

```json
{
  "swanson": {
    "constructorKey": "key_S3qQqhjIprv5M63j"
  },
  "channels": {
    "swanson": { "requestIntervalMs": 3000 }
  }
}
```

Add both `https://www.swansonvitamins.com` and `https://ac.cnstrc.com` to
`brandScans.scraperApi.allowedOrigins` in those files, keeping other allowed origins and the
existing ScraperAPI credentials. The Constructor key is the public storefront client key;
it has no code default. Product capture's separate `capture` settings do not need this origin.
The API fixture contains only a dummy Constructor key, not saved website responses.

Merge the interval into the existing channel options, retaining any proxy/header settings.
In the **API config only**, set the gap alongside the existing Swanson permit:

```json
{
  "permits": {
    "swanson": {
      "taskQueue": "v3.pipeline.product.v1",
      "resourceQueue": "v3.resources.v1",
      "resourceId": "swanson-brand-scan",
      "maxWaitSeconds": 900,
      "gapAfterSeconds": 30
    }
  }
}
```

Both brakes are generic, validated at startup and default to `0` (no pause) for every channel.
The recommended Swanson values are `brandScans.channels.swanson.requestIntervalMs: 3000`
and `brandScans.permits.swanson.gapAfterSeconds: 30`. The first is a pause after the previous
page has been read and parsed, before requesting the next page. A name hit follows API page 1 →
API page 2. A name miss follows name lookup → collection → API page 1 → API page 2.
There is no pause before the first request or after the final page. It also
applies when the reader reuses an archived page. The activity's AbortSignal interrupts the
[Node promise timer](https://nodejs.org/api/timers.html#timerspromisessettimeoutdelay-value-options)
immediately. The value must be an integer from 0 to 2,147,483,647 ms;
it is a listing setting, never a ScraperAPI provider option.

The gap is a nonnegative integer number of seconds. After success, partial/Review results
or failure, `BrandListingWorkflow` keeps its channel permit during a durable Temporal sleep.
With the Swanson capacity of 1, the next scan cannot acquire it until the gap and release
finish. Cancellation skips an unstarted gap or interrupts one already running; the gate's
non-cancellable finally still releases the permit. No permit means no inter-scan gap.
The marker `brand-listing-gap-v1` preserves the command sequence of older unpatched histories.
New starts receive the configured gap; reattaching to an existing workflow retains its input.

For 10 small brands whose stored names all match and fit on one API page each, the configured
pauses add 10 × 30 = 300 s, including the final release gap. Each name miss adds two request
intervals (6 s at the recommended setting), plus the collection and replacement API page's
fetch/archive time. Extra API pages add 3 s each plus fetch/archive time; permit contention
can add further waiting. These are pause budgets, not scan deadlines.

The shared Swanson settings schema validates the supplied key at startup. Without Swanson
settings, unrelated channels and product capture remain available, but a Swanson scan fails
with `SWANSON.CONSTRUCTOR_KEY_MISSING` before its first paid request. A missing or ambiguous
collection title fails with `SWANSON.COLLECTION_TITLE_MISSING`; bot challenges retain
`BRAND_SCAN.ACCESS_CHALLENGE`. Invalid Constructor JSON fails with `BRAND_SCAN.NOT_JSON`.

## Interface and completeness

`BrandScanReader.resolve` is an optional generic capability. It receives the normalized source
URL and optional stored `brandName`, then returns a request (URL, stable archive label, response
type, byte limit, and parser) or a resolved listing. A parser can choose another request or
return the opaque listing base URL, an optional already-read first page, and name evidence.
The app executes those steps through the same archive and pacing path as ordinary pages;
all Swanson name-selection decisions remain in the channel. Repeated resolution labels fail
before another read. Other readers keep their existing single-stage behavior.

Swanson uses `resolve-name` for the stored-name API lookup, `resolve` for fallback collection
HTML, and `page-N` for subsequent listing requests. On a hit, `resolve-name` is listing page 1
and the loop continues at `page-2` without fetching `page-1` again. On a miss, the fallback
title's listing starts at `page-1`. Every request's credits are included; the zero-result
lookup and collection HTML do not inflate listing page/card counts.

The optional `nameResolution: { brandName, usedFallback }` field appears in the listing result
and persisted scan result (including partial listings). `brandName` is the exact name used for
the selected listing; `usedFallback` records whether collection resolution was needed.
Historical results omit the field. The generic gated workflow request carries `brandName`
through to the worker; old requests that omit it remain valid. Failed resolution retains its
error and available request evidence, without claiming a name was successfully selected.

`BrandScanReader.origins` separates listing targets from the adapter's product HTTP policy.
Swanson allows its storefront and Constructor here; ScraperAPI still enforces the private
allowlist independently. Limits are 6 MiB for the entry HTML, 8 MiB per JSON page, and 250 JSON
pages (25,000 cards). Repeated reads of the same scan reuse its verified archives.

Every card and every variation becomes a product at `/p/<handle>`, deduplicated by handle.
The listing ID matches Swanson product capture's `productAddress` and `pageIdentity`. No
Shopify variant ID is inferred from a Constructor SKU; it remains unknown until capture.
The scan no longer expands families by fetching product pages.

A full scan requires consecutive pages, consistent `total_num_results`, the expected number
of cards on each page, and exactly that many distinct card IDs across all pages. Variations
do not inflate the card count. Missing, repeated, truncated or capped results are partial;
they never trigger missing-listing revisits. Invalid responses and fetch/archive failures
retain their Review reason instead of becoming empty successful scans.

## Shared browser scan pacing

Whole Foods now uses the same ResourceGate and scan-gap helper through `BrowserScanWorkflow`,
with its own capacity-one `wholefoods-brand-scan` resource. Its defaults are a 60-second gap
and a 1,800-second cool-down after a broken/throttled read; Swanson's settings and history
remain unchanged. Worker canary/press pacing and API permit examples are in
[the machine configuration guide](machines.md#whole-foods-品牌扫描节流待部署).
The browser marker `browser-scan-permit-v1` retains the old activity-only replay path.
The longer of gap and cool-down is held inside the permit; cancellation follows the existing
Swanson policy. This is source-only work awaiting owner review and Mini verification.

## Verification

Stored-name validation on 2026-09-30: `pnpm lint` and `pnpm check` passed (formatting, dependency
boundaries, duplication and TypeScript included). Vitest passed **114 files / 927 tests**:
all tests in `packages/channels/swanson`, `packages/channels/core`, `packages/app`, `apps/api`
and `apps/worker`, plus the changed Postgres result decoder and Temporal listing adapter tests,
and the listing workflow unit/bundle tests. Coverage includes a hit without a collection read,
a zero-result miss followed by collection/title lookup, HTML and provider challenges during
fallback, invalid and truncated API responses, completeness, per-request pauses, cancellation
between resolution requests, archive separation, and stored-name/result delivery across layers.

The requested fresh direct Constructor check could not run: the first request (Allimax)
failed DNS resolution for `ac.cnstrc.com` with `ENOTFOUND` in the sandbox. No fresh totals were
obtained for Allimax, Amazing Herbs, ChildLife Essentials, Culturelle, Arthur Andrew Medical,
or Herb Pharm. No deployment, production scan, or Git state change was performed.

Earlier verification of the collection-first implementation is retained below. These prior
observations are not fresh totals from the stored-name check.

Automated fixtures are small hand-written HTML/JSON. The owner's saved Herb Pharm server
HTML was also parsed locally and resolved to `Herb Pharm`. A bounded direct public API check
on 2026-09-30 returned 28 cards / 28 products for Herb Pharm and 44 cards / 65 products for
Healthy Origins; both passed the reader's completeness check. Downloaded responses remain
outside the repository under `/private/tmp`.

This code task does not deploy or exercise production ScraperAPI/R2. Before a production
batch, manually deploy through Git and verify one scan and its permit release on a Mini.
Pacing tests cover page intervals, cancellation, permit retention and zero delays. The replay
suite uses `TestWorkflowEnvironment.createLocal()` with 1-second gaps and records old
unpatched, new, concurrent and cancelled histories entirely in memory.

Pacing validation on 2026-09-30: `pnpm check` passed (including lint, format, dependency,
duplication and TypeScript checks); 148 selected test files / 1,134 tests passed, including
the listing workflow bundle test. PostgreSQL integration tests and Temporal server tests
were excluded on the MacBook under the integration-machine rule. The main session still
needs to run these Temporal suites:

- `collection/brand-listing-workflow.replay.test.ts` (changed)
- `collection/collection-workflow.temporal.test.ts`
- `resources/resource-gate.replay.test.ts`, `resources/resource-gate.temporal.test.ts`
- `product-pipeline-workflow.replay.test.ts`, `browser-scan-workflow.replay.test.ts`
- `label/label-workflow.replay.test.ts`, `label/label-heartbeat.temporal.test.ts`

All paths above are relative to `packages/workflows/src/`. This pacing task changed local
source and documentation only; Git commands were read-only and no deployment was performed.

## Files changed for stored-name lookup

Paths are relative to the repository; braces group files in the same directory.

| Area | Files |
| --- | --- |
| Swanson resolution and tests | `packages/channels/swanson/src/{brand-resolution.ts,brand-scan.ts,brand-scan.test.ts}` (`brand-resolution.ts` is new) |
| Generic resolution contract and archive tests | `packages/channels/core/src/listing/{brand-scan.ts,listing-pages.test.ts}` |
| Application orchestration, result and tests | `packages/app/src/brand-scans/{http-listing-pages.ts,http-listing-pages.test.ts,scan-listing.ts,scan-model.ts,brand-scan-runner.ts,brand-scan-runner.test.ts,swanson-listing.test.ts}` |
| Persisted result decoding | `packages/adapters/src/postgres/{brand-scan-queries.ts,brand-scan-queries.test.ts}` |
| Gated request delivery | `packages/adapters/src/temporal/{temporal-brand-listings.ts,temporal-brand-listings.test.ts}`, `packages/workflows/src/collection/brand-listing-model.ts` |
| API and worker wiring tests | `apps/api/src/brand-scan-parts.test.ts`, `apps/worker/src/config.test.ts`, `apps/worker/src/activities/brand-listing-activities.test.ts` |
| Operations documentation | `docs/operations/swanson-brand-scans.md` |

## Files changed for pacing

Paths are relative to the repository; braces group files with a common directory/name.

| Area | Files |
| --- | --- |
| Listing configuration and provider options | `packages/channels/core/src/listing/{listing-fetch-settings.ts,listing-fetch-settings.test.ts,listing-pages-factory.ts}` |
| Page orchestration and permit settings | `packages/app/src/brand-scans/{http-listing-pages.ts,http-listing-pages.test.ts,scan-listing.ts,scan-permits.ts,scan-permits.test.ts,swanson-listing.test.ts}` |
| API wiring and separate evidence settings | `apps/api/src/{brand-scan-parts.ts,brand-scan-permits.test.ts,config.ts}` |
| Worker wiring | `apps/worker/src/activities/{brand-listing-activities.ts,brand-listing-activities.test.ts}` |
| Temporal input delivery | `packages/adapters/src/temporal/{temporal-brand-listings.ts,temporal-brand-listings.test.ts}` |
| Workflow and compatibility tests | `packages/workflows/src/collection/{brand-listing-model.ts,brand-listing-workflow.ts,brand-listing-workflow.test.ts,brand-listing-workflow.bundle.test.ts,brand-listing-workflow.replay.test.ts}` |
| Shared replay helpers | `packages/workflows/src/testing/replay/{bundles.ts,history.ts}` |
| Operations documentation | `docs/operations/{swanson-brand-scans.md,machines.md}` |

## Files changed in the earlier collection-first rework

Paths below are relative to the repository. Existing uncommitted Swanson work was reworked;
unrelated working-tree changes were preserved.

| Area | Files |
| --- | --- |
| Swanson reader | `packages/channels/swanson/src/brand-scan.ts`, `collection-page.ts`, `constructor-page.ts`, `brand-scan-settings.ts`, `configured-adapter.ts`, `swanson-errors.ts`, `index.ts` |
| Swanson tests | `packages/channels/swanson/src/brand-scan.test.ts` |
| Generic capability and archive tests | `packages/channels/core/src/listing/brand-scan.ts`, `listing-pages.test.ts` |
| Application orchestration and tests | `packages/app/src/brand-scans/scan-listing.ts`, `http-listing-pages.ts`, `swanson-listing.test.ts` |
| API wiring and tests | `apps/api/src/brand-scan-config.ts`, `brand-scan-parts.ts`, `brand-scan-parts.test.ts`, `resources/channel-registry.ts`, `fixtures/api-config.json` |
| Worker wiring and tests | `apps/worker/src/config.ts`, `config.test.ts`, `channel-registry.ts` |
| Dependency declaration | `packages/channels/swanson/package.json`, `pnpm-lock.yaml` (existing catalog Zod version only) |
| Owner documentation | `docs/operations/machines.md`, `docs/operations/swanson-brand-scans.md` |

Removed the obsolete untracked `packages/channels/swanson/src/scan-family.ts` and
`scan-family.test.ts`. Product capture's own `family.ts` and its tests remain in use.
