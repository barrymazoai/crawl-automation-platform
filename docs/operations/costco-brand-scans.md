# Costco channel — R21

This implementation is source-only, pending owner review and one-product acceptance on a Mini.
No deployment, live requests, migration application or queue changes were performed.
Configuration merge examples are in [machines.md](machines.md#costco-channel-r21-source-only-pending-mini-acceptance).

## Capture and identity

Brand lists are browser-only. The adapter reads rendered `ProductTile_<onlineId>` links,
never the protected Kasada catalog API. `/p/` banners outside these tiles do not enter the
list. Each brand/category URL is a separate source; the shared product queue deduplicates
by channel/listing. The saved navigation contains `/protein.html`; it does not establish
the diet & nutrition category URI. Source URL validation accepts any category slug, so that
URI can be supplied by the owner without a code change.

Product pages use ScraperAPI raw HTML through `HttpCapture`: the shared seven-day reuse
window and archive/read-back requirement apply before identity checking or parsing. Both
`.product.<onlineId>.html` and `/p/-/<slug>/<onlineId>` identify the same product. JSON-LD
`sku` and printed `Item` are warehouse item numbers, retained separately. A redirect to a
different product or away from products is unlisted with its reason; 404/410 is `not_found`.
An out-of-stock product is still a live listing.

The configured warehouse is Southlake 669 / ZIP 76051. Lists must show Southlake; products
are checked when a warehouse is present. A mismatch is `COSTCO.STORE_MISMATCH`, never an
automatic store switch. Metrics always record the configured warehouse and whether the
page actually verified it. The supplied raw product HTML has no selected retail warehouse.
The page-data price warehouse `847` is an online pricing context, not a selected retail store.

Prices retain their labels and source. Rendered prices take precedence; otherwise the
page-data delivered price is used, falling back to JSON-LD. The supplied energy shot has
online price 43.99 and delivered price 35.99 (8.00 discount); both are retained. No member
price or local inventory is inferred. Ratings and review counts are observed JSON-LD values.
Availability is recorded as unknown: the raw page's JSON-LD always says `OutOfStock` while the
brand page shows the same items in stock (real stock loads later in the browser).

## Formula and images

Costco owns its formula by channel + online listing ID; it does not share Amazon formulas.
The normal pipeline saves metrics on every capture and reuses a known formula. New formulas
use `costco.http-projection` → `ProductPlans` → the existing label pipeline. With
`text-facts-first/1`, complete scoped facts text is the sole required source; incomplete
facts keep the images. Supplement/Nutrition/Drug Facts panels are preserved as printed;
script translations are excluded. Completeness uses the existing conservative shared rule,
so drug/nutrition panels missing its serving/ingredient requirements retain image fallback.

The two supplied pages have empty nutrition data and no printed facts panel. Their embedded
product-gallery attachments explicitly list full-size JPEG originals (CoQ10: 3; energy shot:
4, including `1711799-847__1nf.jpg`). The parser selects those attachments by the warehouse
item number. It never rewrites AVIF filenames into guessed JPEG URLs. Without attachment
data it retains observed gallery candidates; an unsupported image format remains a truthful
file-acquisition Review. Original-image verification still belongs to file acquisition.

## Scanning and lifecycle

Costco reuses Whole Foods' archive/canary algorithm, extracted once into `channels/core`.
Each browser read uses the platform `READ_PAGE_BODY` and closes its exact task-owned page,
verifying absence. User control remains a hard stop. Byte-exact drawn HTML and hash/size,
provider, warehouse, readiness and scroll proof are archived before parsing. Reattaching
to the same scan reads the retained archive; incomplete archive publication is never redrawn.

The shared scroll loop clicks visible enabled Show More/Load More/Next controls when present,
otherwise scrolls. Accessible next anchors are opt-in for Costco; existing Whole Foods
selectors and pacing stay unchanged. A stable end is complete even at exactly 24 products
without a paging control. Page totals are informational. Replaced/shrunken lists are broken:
retain prior observed links, return partial, request cooldown. A capped/readiness-failed
scan stays partial. Paging beyond 24 still needs live Mini verification.

An explicit no-results page is provisional until the configured canary returns healthy
products at the same warehouse. Empty/loading/broken canaries cannot establish not-sold.
The site's unchecked **Show Out of Stock Items** default is preserved. Missing products in
a complete scan trigger the existing product-page revisit; only that revisit decides live
or unlisted. No scan infers a delisting from absence alone.

The global `costco-brand-scan` permit holds one slot across the scan and its 60-second gap,
or 1,800-second cooldown for broken/throttled results. The existing
`browser-scan-permit-v1` and ResourceGate markers are unchanged. Whole Foods' previous
unpatched histories retain their old command path. Replay scenarios now cover both channels;
no new workflow marker is needed because the workflow implementation is unchanged.

## Verification and owner acceptance

Real HTML remains outside git. Set `COSTCO_FIXTURE_DIR` to the directory containing
`brand-list-nature-made.html`, `product-coq10-100029983.html` and
`product-energy-shot-4000100002.html`, then run:

```sh
pnpm --filter @crawl-automation/channels-costco exec vitest run
```

Missing saved files skip their tests. Committed fixtures are small synthetic examples.
Unit tests cover parser/projection identity, prices, facts/images, archive-before-parse,
redirect/not-found sightings, text-first label planning, warehouse mismatches, complete/
broken/capped scans, canaries, permits and API/worker routing.

Before a batch, run the migration and Temporal replay suites on the authorized servers,
then one brand scan and one product end to end through R2, JPEG acquisition, OCR/models,
metrics/formula persistence and permit/page cleanup. Start services manually. Open owner
items: confirm the diet & nutrition source URI, verify the default Kirkland canary at
Southlake, and observe a brand with more than 24 products. No credentials are needed locally.
