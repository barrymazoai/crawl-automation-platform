# DTC adapter

`createDtcAdapter(sites)` creates one `dtc` registry entry, with `captureModes: ["browser"]`.
Use `BrowserPages` backed by `EgoPages`. No reader requests a URL, uses ScraperAPI, or executes
page scripts. The shared capture archives and reads back HTML before parsing. `DtcCatalogPages`
also retains scroll completion evidence and refuses a second read after an unresolved capture.
Ego owns the task page and its verified closure; this package does not take back user control.

Site policies supply the site key, observed platform, catalog URL, allowed page/image origins,
product path, catalog selectors, scroll settings and optional pure product hook. Brand evidence is
the site key, never the Shopify vendor or JSON-LD brand. The only default policy is the requested
first site, `nutriessential.com`, with platform `unverified` and catalog URL `null`. Its refused
plain request is not evidence of a platform or catalog address. A browser check must fill these in.
No inferred list of the other roughly 60 sites has been added: the Plane CLI uses network requests,
which this task prohibits, and no local R20 plan copy was found.

Platform readers in `channels/core/src/platforms` take a supplied DOM:

- Shopify reads embedded product/collection records and JSON-LD fallback, rendered selected
  variants, integer-cent or decimal-string prices, stock, images and description facts.
- WooCommerce reads JSON-LD and `data-product_variations`, including selected variation and
  attribute query parameters. Deferred variation AJAX data is refused, not requested.
- Generic JSON-LD reads Product records, including `@graph`, and variant-specific offers. Ambiguous
  products are refused. Aggregate price ranges are not treated as a selected purchase price.

The adapter stores native product ID and site key in `DtcRendered`. Contract-safe listing keys are
SHA-256 of the JSON tuple `[siteKey, productId]`; variant ID is separate. Address/page comparison
uses the same encoding with the canonical product path (as Swanson separates handles from native
IDs). Core owns `identity_conflict`. Facts need a serving quantity, ingredient amounts and Other
Ingredients. Common facts on multi-variant products remain unassigned, keeping label images.
Images include observed gallery, description, accordion and variant images; recommendations are
excluded within the selected product scope. Site-specific DOM and image origins need verification.

`DtcBrandScan` follows observed next links within the configured catalog. A scan starts only at its
configured entry, stops partially at scroll/page caps, and refuses cycles/repeated pages. Full
completion requires stable scrolling on every page and no next link on the final page. It uses a
separate browser scan entry point, like Whole Foods, rather than the HTTP-only `brandScan` hook.

## Registration outside this change

Add `"@crawl-automation/channel-dtc": "workspace:*"` to the API and worker package dependencies,
update the workspace lockfile and install/link dependencies in the normal integration step.
No install or manifest change outside this new package was performed here.

In the API channel registry and worker registry:

```ts
import { createDtcAdapter } from "@crawl-automation/channel-dtc";
const dtc = createDtcAdapter(dtcSites);
const registry = new ChannelRegistry([...existingAdapters, dtc]);
```

In browser capture wiring, pass the configured Ego instance and add the DTC channel:

```ts
import { DTC_BROWSER_POLICY, DtcCatalogPages, DtcBrandScan } from "@crawl-automation/channel-dtc";
const pages = new BrowserPages(ego, {
  ...browserSettings,
  channels: { ...browserSettings.channels, dtc: DTC_BROWSER_POLICY },
});
const catalogPages = new DtcCatalogPages({ browser: ego, publication });
const dtcScan = new DtcBrandScan({ pages: catalogPages, sites: dtcSites });
```

The existing API service must call `dtcScan.scan` through its authorized browser scan path; do not
put this adapter in the HTTP scan runner. A browser resource permit is required. Existing
`ProductCapture.capture` hardcodes `registry.forCapture(channel, "http")` and needs capture-mode
routing; registering DTC alone does not enable product runs. `ChannelPlanInputSchema` currently
requires a null variant for every channel except Swanson and must allow DTC variants before
formula planning can run. Those files, app configuration and composition roots were outside scope.

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

Standard `tsc`/Vitest commands cannot currently resolve the new package's workspace dependencies;
core also lacks its installed link to `@aws-sdk/client-s3`. Offline verification can resolve these
same already-present modules from the local pnpm store without changing manifests or installing.
This verifies code behavior, not a completed workspace installation or live acceptance.
