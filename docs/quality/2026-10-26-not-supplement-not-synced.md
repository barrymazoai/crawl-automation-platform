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
