# Amazon history recapture

Owner 2026-10-24 (KAN-226). Amazon brand scans only queue the products they list, and only revisit products the
same source queued before. The 09-13…09-29 captures came from the ASIN list and are owned by the disabled
`https://www.amazon.com/` placeholder sources, so round 3 never captured about 12,655 of them again (no queue item,
no observation since 09-29). `queue.recaptureHistory` queues such products again through the shared queue, under a
real, enabled brand source, so later scans of that brand know them.

## Selection

- Amazon listings whose latest V3 capture (`product_history_observation`, kind `metrics`, source `v3:amazon`) is
  older than `lastObservedBefore` (a listing whose captures all lack `observed_at` is never selected);
- no queue item for the listing was created since `lastObservedBefore`;
- the latest listing sighting is not `unlisted`.

Each product is queued under an **enabled** Amazon source, decided in this order:

1. the enabled source that last queued it, if the captured page's brand agrees (otherwise
   `queued_source_conflict`, not queued);
2. the source whose brand name, search keyword `k` or store path name equals the brand on the captured page
   (`Visit the X Store` / `Brand: X`, compared without accents, case or punctuation). Ties prefer the brand named
   exactly, then the search list, then the one brand whose name contains the page brand;
3. the enabled source of the capture's own brand (the placeholder's brand), when the page names no brand or names
   that same brand (e.g. page "MICHAEL'S", brand "Michael's Naturopathic Programs");
4. otherwise it is not queued and is reported under `unresolved` (`no_page_brand`, `no_enabled_source`,
   `ambiguous_source`, `queued_source_conflict`) with its page brand in `unresolvedBrands`.

Product runs do not refuse disabled sources (only brand runs do), but the placeholder sources name the old
grouping, often a former company rather than the product's brand ("Nature's Bounty" holds Horbäach and Best
Naturals products, "Amazon 未分组" holds 1,241). `brandChanges` counts resolved products whose new source belongs to
another brand than the capture's owner. Supply Smart keeps an existing listing on its product (it matches channel +
ASIN first), so a brand change does not move or duplicate an existing Supply Smart product.

The source does not change how the product page is captured (Amazon product runs use the product address over
HTTP; the source URL is only used by brand scans). Queued products follow the normal pipeline: products with a
known formula only refresh metrics, the 24-hour paid fetch admission applies, a vanished page is recorded as
unlisted with its reason.

## Run

Preview (default, read-only; returns `batchId` for the selection):

```bash
curl -s -X POST http://127.0.0.1:4188/trpc/queue.recaptureHistory -H 'content-type: application/json' \
  -d '{"channel":"amazon","lastObservedBefore":"2026-10-01T00:00:00Z","limit":50}'
```

Queue: send the same request with `"dryRun":false,"expectBatchId":"<batchId from the preview>"`. A selection that
changed since the preview (or a retried request after the first one queued) is refused with
`QUEUE.RECAPTURE_SELECTION_CHANGED`, so nothing beyond the previewed batch is queued. `listingIds` (≤200 ASINs)
restricts the candidates, e.g. for a pilot; ASINs that are not candidates come back in `notCandidates`.

Start with a 50-product pilot (half under search-list sources, half under store-page sources), check captures,
formula reuse and the Supply Smart sync, then send batches of at most 2,000 and check Review share and Server 一
disk between batches.

Preview of 2026-10-24 (cutoff 2026-10-01): 12,656 candidates; 11,849 resolved (11,653 by page brand, 196 by the
capture's own brand; 7,641 under search lists, 4,208 under store pages; 2,340 brand changes); unresolved 779
without an enabled source (Herb Pharm 242, The Vitamin Shoppe 194, TheraBreath 30, …), 17 without a page brand,
11 ambiguous.
