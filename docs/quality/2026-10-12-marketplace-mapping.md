Marketplace mapping, step 2 (2026-10-12)

Implemented `marketplaceItem(product, { domain, runId, companyId? })` and `marketplaceLabel(...)` in
`marketplace-mapping.ts`. Outputs use the existing `DeliveryItem` / `DeliveryLabel` wire types and the same
`SupplySmartObservationWriter` transport. The item has no `channel`: the contract puts it on the enclosing run.
It has no `siteKey`; the label channel is explicit. `runId` is the Supply Smart batch identifier, not the capture
run. Labels retain stable identities independent of that batch, matching DTC's replay behavior.

The shared DTC item and full-label builders were extracted without duplicating them. Existing semantic mapping,
label content/evidence, label completeness, gallery scoping, RPC response schemas and hashes remain shared.
History numeric strings now convert to numbers for rating/count fields. DTC still supplies its site namespace,
uses its original owner gate and produces the same valid payloads; its tests were not edited.

| Channel     | `externalId`                                                                     | Page, capture and commerce                                                                                                     | Name/semantics                                                                        | Label                                                                                         |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Amazon      | Selected website variant ID when present, otherwise ASIN                         | Amazon's own history and retained projection                                                                                   | Own attached enrichment; raw title fallback                                           | Own current-run collection                                                                    |
| GNC         | Selected variant ID when present, otherwise GNC SKU                              | GNC's own history and projection                                                                                               | Same rule                                                                             | Own current-run collection                                                                    |
| Swanson     | Selected Shopify website variant ID; otherwise page product ID/handle            | Queue handle is joined to the exact run/source/page history; commerce SKU is kept as evidence, not substituted for the variant | Own subject supplies the selected website identity; own enrichment supplies semantics | Own collection for the selected website variant                                               |
| Whole Foods | ASIN (selected website variant when present)                                     | Whole Foods history, store, title and gallery; never Amazon commerce                                                           | Same-ASIN Amazon enrichment when available; otherwise Whole Foods title               | Latest completed/settled Amazon collection of the same ASIN; absent collection means no label |
| Costco      | Selected child/item variant when present, otherwise captured item/listing number | Costco's own history and retained projection                                                                                   | Own attached enrichment; raw title fallback                                           | Own current-run collection                                                                    |

The following mapping applies to all five channels unless the table states an exception.

| Supply Smart field                                                   | Source and omission rule                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientRef`                                                          | Stable hash of channel and selected external ID; independent of company and sync batch                                                                                                                                                                          |
| `domain`; label `company.domain`                                     | Required mapper input from the brand→company match; never taken from the retailer URL                                                                                                                                                                           |
| Label `company.expectedCompanyId`                                    | Optional `companyId` input                                                                                                                                                                                                                                      |
| `siteKey`                                                            | Absent in item and label listing (marketplace storage is NULL)                                                                                                                                                                                                  |
| `sourceUrl`, `productUrl`                                            | Own selected website variant URL when present / own capture history URL; retained product page URL                                                                                                                                                              |
| `productName`, `titleRaw`                                            | Enrichment `candidate.unifiedName` else retained title; raw retained title                                                                                                                                                                                      |
| `brandName`                                                          | Own retained `brandRaw`; fallback to the queue's crawler brand                                                                                                                                                                                                  |
| `capturedAt`                                                         | Capture-history time, never processing or sync time                                                                                                                                                                                                             |
| `baseName`, `productForm`                                            | Enrichment base name and known form; `unknown`/`other` forms omitted                                                                                                                                                                                            |
| `variant`                                                            | Enrichment flavor, strength, size, known form; count becomes size `N count`, never pack/servings. Recognized selected website option keys override corresponding AI values. An explicitly printed `120 Count (Pack of 3)` becomes size `120 Count` and pack `3` |
| `variantSource`                                                      | `channel_attrs` if recognized structured selected options contribute; otherwise shared `ai_extract` enrichment mapping                                                                                                                                          |
| `variantConfidence`                                                  | Existing enrichment confidence ×100, rounded; no invented confidence for website-only options                                                                                                                                                                   |
| `gtin`                                                               | A unique string with exactly 8/12/13/14 digits under UPC/EAN/GTIN/MPN in retained attributes or history/commerce fields; absent/invalid/conflicting codes omitted. Never SKU-as-GTIN                                                                            |
| `healthFunctions`, `mainIngredients`                                 | Printed enrichment health functions and functional ingredients; inferred functions excluded                                                                                                                                                                     |
| `price`, `currency`, `listPrice`, `inStock`                          | Non-null history metrics; false and zero retained, no defaults                                                                                                                                                                                                  |
| `rating`, `reviewCount`, `salesRank`, `unitsSold`, `unitsSoldPeriod` | Non-null history metrics; numeric strings converted strictly, period retained                                                                                                                                                                                   |
| `images`                                                             | Shared full gallery mapping: only shared/current-variant images, stable gallery handles; label endpoint capped at 50                                                                                                                                            |
| `attrsRaw`                                                           | Original website variants/options, selected website variant, supplied structured attributes and selected options                                                                                                                                                |
| `extras`                                                             | Retained commerce, store/purchase context and crawler collection/source provenance                                                                                                                                                                              |
| `facts`, `variantKey`, `listedAt`, `listedAtSource`                  | Not manufactured; formula goes through full-label endpoint, no local identity-key computation                                                                                                                                                                   |
| Label `submitter`, `observation`, `source`                           | Existing `crawler-v3` namespace, hashed collected operation, collected identity and original time; source `crawler-v3:product-delivery`                                                                                                                         |
| Label `content`, `evidence`                                          | Shared lossless formula/other-ingredients/citations, source completeness, warnings, packaging, assembly and provenance mapping; no fabricated label confidence                                                                                                  |
| Whole Foods label identity/time                                      | Separate stable identity hashes the Whole Foods capture and Amazon collection; keeps original Amazon observation provenance and capture time. Whole Foods commerce is omitted from this label call to avoid backdating it; commerce is sent in the batch item   |

`PostgresMarketplaceReader` in adapters takes `{ database, objects, channels }`. `channels` is the existing registry;
only its pure retained-page/projection parsers are called. Standard retained projections and original object SHA-256
checks reuse `retainedProjection`; Swanson's nonstandard saved projection uses the existing planning decoder.
Whole Foods has no enrichment-owned projection, so its own verified retained HTML is read with its existing channel
parser. No website request, new OCR/model task, queue mutation or Supply Smart call occurs.

`read({ channel, limit, after? }, signal)` returns `{ products, after }`. Limit is 1–200. The cursor is
`{ listingId, variantId }` and is channel-scoped. Selection takes the latest queue row per channel/listing/variant
before checking completed state and the exact run/item/channel settled receipt. A newer Review or pending row
cannot expose an older success. The extra row detects the next page. Each bad material row remains in the page
with its `problem`, and the cursor advances over it. Collection/history/enrichment/projection hashes and ownership
are checked; ambiguous unassigned collections are refused. SQL lives only in adapters.

Real sample evidence used:

| Channel     | Real IDs and fields exercised                                                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amazon      | `B00F42FV5I`, `B00551W73C`, `B0FFTMHSMC`: real labels and subjects, string ratings/reviews, `50` units sold with `trailing_30d`, selected Size controls with Pack of 3, unavailable stock and absent price/currency                                                                                              |
| GNC         | `967060`, `424743`, `452410`: real SKU/title, price/rating/reviews/stock, printed functions, AI size/form/flavor and full image/text label provenance                                                                                                                                                            |
| Swanson     | Handles `country-life-core-daily-1-women-50-60-tabs`, `solgar-omega-3-fish-oil-concentrate-120-sgels`, `procera-probiotic-11-5-billion-cfu-60-veg-caps`; history SKUs `CRL530`, `SLG314`, `PRC011`; actual website variants `46318742077578`, `46319034728586`, `46318999142538`; absent currency remains absent |
| Whole Foods | `B0GHDHVL1Z`, `B00280M14S`, `B00323XJ8W`: no collection/enrichment, false stock, absent price/currency, store `10259` / The Alameda; no title invented from ASIN                                                                                                                                                 |
| Costco      | `4000428043`, `4000349261`, `4000354013`: prices/string ratings/review counts, selected enrichment semantics; AG1's real source mismatch retained as failure                                                                                                                                                     |

The sample file provides object references, not retained projection bytes. Eleven labeled samples map successfully
from their real records plus an explicitly documented minimal projection scaffold. Costco AG1 is rejected because
its queue source differs from its archived owners. The three Whole Foods samples lack titles in the export; tests
retain that missing-material result and separately supply an explicit projection test double to check observation-only
mapping. No live GTIN appears in these 15 histories; GTIN/gallery/linked-label edge tests are supplemental, not claimed
as real captures. See `fixtures/README.md` for trimming and provenance.

Integration wiring without touching the parallel job's indexes:

```ts
// packages/app/src/product-sync/index.ts — add:
export * from "./marketplace-mapping.js";

// packages/adapters/src/index.ts (or its product-sync barrel) — add:
export * from "./product-sync/marketplace-reader.js";
```

Standalone package subpaths are already available as `@crawl-automation/app/marketplace-mapping` and
`@crawl-automation/adapters/marketplace-reader`. The reader uses the app subpath, so it does not depend on the
parallel index edit. `MarketplaceChannel` is re-exported from the parallel job’s `ledger.ts`, so these barrel additions do not
introduce a second conflicting type.

Checks: 22 marketplace mapping tests and all 42 unchanged DTC delivery tests passed. App and adapters type
checks passed; changed TypeScript files passed ESLint and all changed files passed Prettier.
The PostgreSQL integration test is supplied but not executed here, per task constraint. The main session can run:

```sh
pnpm --filter @crawl-automation/adapters exec vitest run src/product-sync/marketplace-reader.integration.test.ts
```

It uses `CRAWL_TEST_DATABASE_URL`, an isolated schema inside a rolled-back transaction, real retained record fixtures
and explicit projection test doubles. It covers all five channel pages, cursor boundaries, newer terminal states,
unsettled/wrong-outcome receipts, the real AG1 mismatch, same-ASIN Amazon label reuse, and corrupt object isolation.
No Supply Smart verification or production completion is claimed. Nothing was committed, branched or deleted.

## Sample provenance (fixture README)

These 15 records come from the supplied `sync-samples/samples.jsonl` export (2026-10-12), three per channel.
Queue identities, complete collected labels/citations/provenance, capture timestamps and normalized metrics,
website identities in enrichment subjects, and enrichment candidates retain their real values.

Trimming removes duplicated commerce `context`, purchase-condition `evidence`, promotion descriptions/conditions,
and enrichment subject descriptions. Formula rows, completeness flags, ingredient fields, packaging, warnings,
assembly references, title-evidence references, selected options and store context are preserved. This is a test
fixture, not an archive replacement; fixture database hashes are recomputed only in integration setup.

The supplied export contains projection references, not projection/HTML bytes. The mapping fixture therefore
builds a minimal projection scaffold using the actual subject's identity and title, with an empty gallery.
The Whole Foods records contain neither collection nor enrichment/title: their missing-material tests retain that
absence. Tests that need a Whole Foods projection explicitly use a test double. Gallery, GTIN, linked Amazon
label and structured-option edge cases are explicitly marked supplemental tests; they are not claimed as live data.

Costco AG1 `4000349261` has queue source `96d8012f-3042-4d97-b08f-b8945121523d`, but history, collected label
and attached subject source `79c6a864-5519-465f-9664-9834e82e684e`. The tests retain and reject that mismatch.

The samples are real crawler data and are not in git (owner 2026-09-30). Tests read them from `CRAWLER_MARKETPLACE_SAMPLES` (this MacBook: `~/crawl-test-data/product-sync/marketplace-samples.json`) and are skipped without it.
