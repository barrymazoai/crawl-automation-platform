# DTC adapter

`createDtcAdapter(sites)` creates one `dtc` registry entry, with `captureModes: ["browser"]`.
Use `BrowserPages` backed by `EgoPages`. No reader requests a URL, uses ScraperAPI, or executes
page scripts. The shared capture archives and reads back HTML before parsing. `DtcCatalogPages`
also retains scroll completion evidence and refuses a second read after an unresolved capture.
Ego owns the task page and its verified closure; this package does not take back user control.

The minimal DTC task is **one brand on one site** (R20, owner rule 2026-09-30). Site policies
supply the kind, site key, platform, catalogs, allowed page/image origins, product path, catalog
selectors, scroll settings and optional pure product hook. No sites are enabled by default:
`DTC_SITES` and the default `browser.dtc.sites` are empty. Real sites belong in private config.

## Private configuration shape

Both worker `browser.dtc.sites` and API `browser.dtc.sites` use `DtcSettingsSchema`.
`kind: "single-brand"` means brand = site key, with one site catalog. Omitting `kind` preserves
the same meaning for existing configs. `kind: "multi-brand"` requires a nonempty `brands` array
and forbids a site-level `catalogUrl`. Every entry names exactly one brand and its catalog URL.
Brand names (trim/case comparison) and catalog URLs must be unique within a site. All catalog
URLs must use the site's HTTPS origin, with no credentials or fragment.

This is a documentation example, not an enabled default. The owner identified
`nutriessential.com` as a multi-brand Shopify retailer (`nutriessential-com.myshopify.com`);
products use `/products/<handle>`. Only the public storefront origin is configured for capture.

```json
{
  "browser": {
    "dtc": {
      "sites": [
        {
          "siteKey": "shop.example",
          "kind": "single-brand",
          "platform": "shopify",
          "catalogUrl": "https://shop.example/collections/all"
        },
        {
          "siteKey": "nutriessential.com",
          "kind": "multi-brand",
          "platform": "shopify",
          "brands": [
            {
              "brand": "Metagenics",
              "catalogUrl": "https://nutriessential.com/collections/metagenics"
            },
            {
              "brand": "Pure Encapsulations",
              "catalogUrl": "https://nutriessential.com/collections/pure-encapsulations"
            },
            {
              "brand": "Life Extension",
              "catalogUrl": "https://nutriessential.com/collections/life-extension"
            },
            {
              "brand": "Allergy Research",
              "catalogUrl": "https://nutriessential.com/collections/allergy-research"
            },
            { "brand": "Thorne", "catalogUrl": "https://nutriessential.com/collections/thorne" }
          ]
        }
      ]
    }
  }
}
```

This fragment supplies only DTC settings; the worker's existing Ego and Whole Foods settings
remain required. `configuredDtcSites(settings)` produces the policies. `dtcBrandSources(sites)`
(also `adapter.brandSources`) expands them into `{ sourceId, siteKey, brand, catalogUrl }`: five
independent sources for the example retailer. Source keys encode site + brand + catalog; they
are channel evidence keys, not database IDs. The existing source service owns database rows.

Platform readers in `channels/core/src/platforms` take a supplied DOM:

- Shopify reads embedded product/collection records and JSON-LD fallback, rendered selected
  variants, integer-cent or decimal-string prices, stock, images and description facts. Vendor
  supplies the page brand; when absent, only the matching JSON-LD Product's brand is used.
- WooCommerce reads JSON-LD and `data-product_variations`, including selected variation and
  attribute query parameters. Deferred variation AJAX data is refused, not requested.
- Generic JSON-LD reads Product records, including `@graph`, and variant-specific offers. Ambiguous
  products are refused. Aggregate price ranges are not treated as a selected purchase price.

Single-brand product evidence still uses the site key. Multi-brand evidence uses the actual page
brand, even when it differs from the source; a missing page brand remains null. `DtcRendered`
keeps `brandEvidence` with seller (site key), source, observed brand and comparison status.
`DTC.BRAND_MISMATCH` retains the disagreement; `DTC.BRAND_UNVERIFIED` marks a missing page brand.
No alias matching or brand merging occurs. Seller is also recorded in commerce context.

The adapter stores native product ID and site key in `DtcRendered`. Contract-safe listing keys are
SHA-256 of the JSON tuple `[siteKey, productId]`; variant ID is separate. Address/page comparison
uses the same encoding with the canonical product path (as Swanson separates handles from native
IDs). Core owns `identity_conflict`. Facts need a serving quantity, ingredient amounts and Other
Ingredients. Common facts on multi-variant products remain unassigned, keeping label images.
Images include observed gallery, description, accordion and variant images; recommendations are
excluded within the selected product scope. Site-specific DOM and image origins need verification.

`DtcBrandScan` resolves exactly one source and follows observed next links within that source's
catalog. It rejects pagination or redirects into another brand's collection, including other
configured brands on the same site. Configured query filters must survive pagination. A scan
starts only at its configured entry, stops partially at scroll/page caps, and refuses
cycles/repeated pages. Catalog originals are isolated by brand source. Full
completion requires stable scrolling on every page and no next link on the final page. It uses a
separate browser scan entry point, like Whole Foods, rather than the HTTP-only `brandScan` hook.
Listed products carry `brand`, `seller`, `brandBasis` and `brandEvidence`: an embedded vendor is
page evidence; otherwise the collection's configured brand is explicitly marked source-derived.

## Source-scoped product parsing

The shared `ChannelAdapter.parseProduct(FetchedPage)` interface has no source parameter. Bind
the adapter to the task's source before parsing or giving it to shared product capture:

```ts
const adapter = createDtcAdapter(dtcSites);
const taskAdapter = adapter.forBrandSource(source.catalogUrl);
const parsed = taskAdapter.parseProduct(retainedPage);
// Or: createDtcAdapter(dtcSites, source.catalogUrl)
```

Multi-brand projections use the local `dtc-product/2` envelope to retain both names, source URL,
seller and mismatch status through archive/planner replay. The shared plan's parser identifier
remains `dtc-rendered/1`, as required by its current contract. Old single-brand projections remain
readable and unbound single-brand captures retain their existing projection shape.

An unbound product read records its actual page brand with `status: "unscoped"` and a null source;
it never guesses which source submitted the product. **Integration boundary:** the existing
worker registers an unbound adapter. Passing the task's database source/catalog into product
capture still requires task/service wiring beyond site-settings parsing, outside this change's
allowed files. The channel supplies source expansion and binding; it does not create database
rows, enqueue tasks or claim unbound production captures perform source-mismatch checks.

## Saved evidence tests

`src/saved-data.ts` resolves files from `V3_TEST_DATA_DIR` (repository-relative layout or basename)
or known local paths. Missing page suites use `describe.skipIf` with an explicit R45/data message.
No real pages or JSON captures were copied into this package or added to git.

| Local saved evidence                                                                | Actual reader coverage                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `real-crawl-results/four-brands-20260910/evidence/innerbody-sleep-support-raw.json` | Shopify raw product: Sleep Support, ID 7540959379542, 3 variants, first price 390.00, 5 images. This is JSON, not full HTML.                                            |
| `real-crawl-results/four-brands-20260910/evidence/bellagrace-products-raw.json`     | 7 Shopify catalog records; first RESTorative Sleep Gummies, ID 8750333198563, variant 45908104151267, price 42.00, 3 images. This is JSON, not full HTML.               |
| `real-crawl-results/seven-brands-20260903/raw/maurten-gel-100-box-us.html`          | Full JSON-LD page: Gel 100, SKU 22002, USD 45.00, InStock, canonical identity and GEL100_US.jpg label image with the observed Maurten DOM/CDN policy. Facts incomplete. |
| Shopify / WooCommerce full product HTML                                             | Not found at searched paths. Real-page suites skip; separate synthetic tests cover both DOM readers and variation boundaries. No hmwmethod HTML was found.              |

Additional tests exercise browser-only registry selection, cross-site identity, selected variants,
facts completeness, image scoping, pagination/end proof, byte-preserving archive reuse and failed
capture admission with in-memory doubles. No live browser/provider/integration test was run.

Multi-brand tests cover the five-source example, worker/API settings, collection pagination and
redirect boundaries, vendor/JSON-LD brands, missing brands, mismatch projection replay, source
isolation and unchanged product/variant identity. Live network/browser verification is separate
from these offline checks.
