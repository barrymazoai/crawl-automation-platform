# Products outside supplements are not synced to Supply Smart (owner 2026-10-26)

## Problem

A product whose store files it outside supplements finishes with `PRODUCT.NOT_SUPPLEMENT` (owner 2026-10-08). The
queue item completes, so the marketplace sync still sent it to Supply Smart as a listing without a label. On
2026-10-26 the Supply Smart test database held 3,011 such products (Amazon 2,744, GNC 152, Swanson 132, Costco 2):
mouthwash, socks, shakers, shampoo, all with no form, health function, ingredient or formula.

## Change

`settledMarketplace` (`packages/adapters/src/product-sync/marketplace-queries.ts`) no longer selects a latest queue
item whose reason is `PRODUCT.NOT_SUPPLEMENT`, next to the existing rule for revisits that found the page gone. The
same selection feeds the sync reader, the sync overview and the Amazon listing-date reopen, so all three agree. A
later capture that decides the product is a supplement makes a newer queue item and the product is sent again.

Products already in Supply Smart are not removed by this change; removal is a separate, approved step.

## Verification

- `pnpm check` passed.
- `marketplace-reader.integration.test.ts` gained a case (a GNC product marked `PRODUCT.NOT_SUPPLEMENT` is not
  read; clearing the reason reads it again). It ran on a throwaway local PostgreSQL with the retained samples outside
  git; it fails without the new condition and passes with it. The formula and materials suites also passed.
- Read-only on the crawler database (Server 一), the selection drops 3,095 settled products: Amazon 2,808,
  GNC 152, Swanson 133, Costco 2; Whole Foods is unchanged.

## Removing the products already sent (`productSync.removeNotSupplements`)

The owner approved deleting group A (2026-10-26): products the crawler created in Supply Smart for listings outside
supplements. The API operation reads the ledger rows whose latest queue item is `PRODUCT.NOT_SUPPLEMENT` and whose
Supply Smart product is on record, in key order, and for each one:

1. reads `product.getDetail` and keeps the product unless its `source` is `enrichment`, its one listing is this
   listing (same channel and Supply Smart listing ID) and it has no current formula and no formula observation
   (kept reasons `PRODUCT_SYNC.KEEP_NOT_CRAWLER_CREATED`, `KEEP_OTHER_LISTINGS`, `KEEP_HAS_FORMULA`);
2. deletes it with `product.delete` (Supply Smart removes its listings, images, snapshots and observations);
3. marks the ledger row `removed` (migration 067); IDs and material time stay on record.

Another row pointing at a product already removed (another variant) is only marked. The first failure stops the run
and is reported; nothing is retried. `dryRun` defaults to true and deletes nothing; `limit` is at most 500 and the
answer's `next` continues after kept products. A later capture judged a supplement is sent again by the sweep.

```sh
curl -s -X POST http://127.0.0.1:4188/trpc/productSync.removeNotSupplements \
  -H 'content-type: application/json' -d '{"limit":500}'                    # dry run
curl -s -X POST http://127.0.0.1:4188/trpc/productSync.removeNotSupplements \
  -H 'content-type: application/json' -d '{"limit":1,"dryRun":false}'      # delete one, then check it
```

Deploy with `--migrate` (067). Products from legacy imports (group B) and NIH products are not touched.

## Run on 2026-10-26 (Supply Smart test)

Deleted **2,624** products (Amazon 2,355, GNC 143, Swanson 124, Costco 2); a read-only check found none of them,
nor any of their listings, left. 2,581 were on the audit's group-A list; the other 43 were delivered after the
audit export and before the sync change, and passed the same checks. Kept, by distinct product: 327
`KEEP_NOT_CRAWLER_CREATED` (legacy imports, group B), 99 `KEEP_OTHER_LISTINGS`, 2 `KEEP_HAS_FORMULA`.

The run was interrupted once at 03:44 UTC when another session deployed an older commit (`17f1990`) to both
servers; after `12649db` was deployed again it continued from the last page's `next`. No failure was reported.

Deferred by the owner: most `KEEP_OTHER_LISTINGS` products are not variants but duplicate Amazon ASINs with the
same title that Supply Smart merged into one product (e.g. Real Aloe spray B003OJ5RP2 / B003OKBZRK). Whole Foods
listings have no store-category check, so a Whole Foods copy of a removed product stays (e.g. B00016WUEW).
