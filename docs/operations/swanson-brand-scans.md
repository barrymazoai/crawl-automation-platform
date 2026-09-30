# Swanson brand listing reader

The collection page is an entry page, not a product list. Its server HTML supplies the exact
`constructor-plp[data-collection-title]` brand name. The reader then requests Constructor's
`/browse/brand/<encoded name>` API, with 100 cards per page. Both stages use the existing
ScraperAPI listing reader and its verified, byte-for-byte R2 archive before parsing.

## Private configuration

In the API file named by `V3_API_CONFIG` and the scanning worker file named by
`V3_PIPELINE_CONFIG`, merge the following into the existing `brandScans` section:

```json
{
  "swanson": {
    "constructorKey": "key_S3qQqhjIprv5M63j"
  }
}
```

Add both `https://www.swansonvitamins.com` and `https://ac.cnstrc.com` to
`brandScans.scraperApi.allowedOrigins` in those files, keeping other allowed origins and the
existing ScraperAPI credentials. The Constructor key is the public storefront client key;
it has no code default. Product capture's separate `capture` settings do not need this origin.
The API fixture contains only a dummy Constructor key, not saved website responses.

The shared Swanson settings schema validates the supplied key at startup. Without Swanson
settings, unrelated channels and product capture remain available, but a Swanson scan fails
with `SWANSON.CONSTRUCTOR_KEY_MISSING` before its first paid request. A missing or ambiguous
collection title fails with `SWANSON.COLLECTION_TITLE_MISSING`; bot challenges retain
`BRAND_SCAN.ACCESS_CHALLENGE`. Invalid Constructor JSON fails with `BRAND_SCAN.NOT_JSON`.

## Interface and completeness

`BrandScanReader.resolve` is an optional generic capability: it defines an entry page's URL,
response type, byte limit, and parser returning an opaque listing base URL. The app reads that
page under archive label `resolve`, then passes the resolved URL to the existing `pageUrl`
loop (`page-1`, `page-2`, etc.). Resolution credits are included; resolution is not counted as
a product listing page. Other readers keep their existing single-stage behavior.

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

## Verification

Automated fixtures are small hand-written HTML/JSON. The owner's saved Herb Pharm server
HTML was also parsed locally and resolved to `Herb Pharm`. A bounded direct public API check
on 2026-09-30 returned 28 cards / 28 products for Herb Pharm and 44 cards / 65 products for
Healthy Origins; both passed the reader's completeness check. Downloaded responses remain
outside the repository under `/private/tmp`.

This code task does not deploy or exercise production ScraperAPI/R2. Before a production
batch, manually deploy through Git and verify one scan and its permit release on a Mini.

## Files changed in this rework

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
