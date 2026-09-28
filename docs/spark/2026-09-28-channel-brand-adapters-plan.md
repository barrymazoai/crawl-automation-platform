# Channel brand adapters plan v2: Amazon brand scan, then Swanson, Whole Foods, Costco, GNC (2026-09-28)

Replaces the first version written earlier the same day.

## User decisions (2026-09-28)

| Question | Decision |
|---|---|
| Queue for the other channels | One shared queue with a channel column. Amazon's existing queue stays untouched. |
| What to build first | Amazon brand scan. |
| New size or pack count of a known product | Reuse the sibling product's formula; record metrics only. |
| New flavour of a known product | Its own formula extraction, because flavours differ in other ingredients, which matter to ingredient-supplier clients (see Phase 2 item 6). |
| Whole Foods product with an ASIN Amazon already has | User asked to check whether they are the same product. Checked: they are (see below). Plan: reuse Amazon's formula. |

| Re-scans | Never automatic. The user starts every brand scan by hand; no schedules are built. |
| Costco scope | Vitamins, protein and sports nutrition, and diet and nutrition, because all matter to the clients. |
| Size variants reusing a formula | Check the formula: compare the new size's label with the saved one before reusing (Phase 2 item 6). |

| Whole Foods store | One store: The Alameda, San Jose (store ID 10259). Its ID is recorded with every metrics row. |

Default: saved formulas are kept forever, as today.

## The process every channel follows

Every product, from a brand scan or a single link, goes through the same product task:

1. Skip if this listing was collected in the last 24h.
2. Capture the product page and archive the original HTML.
3. Record the metrics every time: price, rating, reviews, stock, sales.
4. Formula once:
   - A formula is saved for this listing → stop.
   - A formula is saved for a sibling (same product family, different size or pack count only) → link to it and stop.
   - Otherwise → download the images, run OCR, text and vision, and save the formula.

A brand scan puts **all** of the brand's products into the queue. There is no separate "new vs known" comparison step.

## Whole Foods vs Amazon check (Ego on the MacBook, 2026-09-28)

4 Nordic Naturals products, same ASIN on both sites:

| ASIN | Title | Whole Foods gallery images also on Amazon | Price WF / Amazon |
|---|---|---|---|
| B002CQU54Q | same (WF adds a marketing suffix) | 7 of 7 | $45.04 / $43.18 |
| B07WMZTX28 | identical | 7 of 7 | $19.11 / $17.67 |
| B0CJ647S9B | same (WF adds a marketing suffix) | 4 of 5 | $22.09 / $24.61 |
| B0096M5PBW | identical | 6 of 6 | $24.21 / $24.61 |

- Same product and same image files, so the formula can be shared by ASIN.
- Prices differ, so Whole Foods metrics must be recorded as its own listing.
- Whole Foods product URLs are `/grocery/product/<slug>-<asin>`.
- Whole Foods shows fewer gallery images than Amazon (5–7 vs 10–18). For an ASIN with no formula yet, extract it from the Amazon page.
- Whole Foods raised a location-permission prompt in Ego. A production run needs that handled once in the run's profile.

### Price by store (Ego on the MacBook, 2026-09-28)

Same Nordic Naturals and Garden of Life search pages, read at three stores: The Alameda (San Jose, store ID 10259), Uptown Dallas and Manhattan West (New York).

- **Of 38 products listed on page 1 at all three stores, 28 have different prices and 10 have the same.**
  - Most differences are 1–10%. Examples: B00Y8MP4G6 $26.00 / $29.06 / $26.00; B007SYT7LO $35.95 / $34.42 / $43.97.
  - The card price can be the regular or the Prime price, so the exact figures are indicative. The same card was read at every store.
- **Product pages** (regular price):

  | Product | San Jose | Dallas | New York |
  |---|---|---|---|
  | Omega-3 Liquid 8 oz | not sold now ($24.21 earlier today) | $30.59 | $25.49 |
  | Children's DHA Gummies | $19.11 | $19.11 | $19.11 |
  | Ultimate Omega 120 | $45.04 | $45.04 | $45.04 |

- **Availability also differs by store.** The Omega-3 Liquid was "Currently not sold in The Alameda", and store search results differ.
- **The site says so itself:** "item pricing may differ depending on your purchase selection, such as online for delivery or pickup, in store or in app."
- **So every Whole Foods metrics row must record its store ID.** Metrics from different stores can't be compared as one price history.

## Facts from the code that shape the plan

1. **The Amazon queue is Amazon-only at every layer.**
   - Tables `amazon_*` (migration 023).
   - `AmazonLinkBatchSchema` requires an Amazon `/dp/ASIN` URL.
   - The runner's settlement checks name Amazon activities.
   - The CLI loads the Amazon config.
2. **Workers accept one brand only.** The Swanson, GNC and non-batch Amazon workers reject every scope except the one in their private config (`AMAZON.SCOPE_CONFLICT`, `swanson-live-worker.ts` L65). Link batches are the only path that works for any brand.
3. **`historyListingId` is required in a batch entry but nothing reads it.** A product that isn't in `product_history_listing` yet has no value to put there.
4. **The formula and 24h checks match on `listingId` only** (`enrichment-store.ts` L31, L37).
   - `collected_product` doesn't store the channel.
   - There is no index on that lookup (full scan).
5. **Swanson's `listingId` is the Shopify product ID, with the variant in `variantId`.** A check on `listingId` alone would give one variant another variant's formula.
6. **Swanson and GNC already record metrics on every run.** They lack only the formula-once check and enrichment.
7. **The brand search tool rejects paging.** `searchAddress` throws on `page=`, and `organicAsins` stops at 10.
8. **Migrations are hash-checked.** 001 can't be edited; changes go in a new `025_*.sql`.
9. **New channel values are needed in about 12 places.** A channel missing from `identifyListing` fails with `HISTORY.CAPTURE_IDENTITY_UNRESOLVED`.

## Phase 1: Amazon brand scan (first)

**Goal:** every Amazon brand URL we already have produces the brand's full product list, and all of it goes through the existing Amazon queue.

1. **Listing scan tool** in `apps/v3-workers/src/brand-entry/`, next to the search tool. It reuses that tool's run directory, lock, progress file, `capture()` with byte-exact archive and sha256 read-back, and the Server 一 broker.
   - **Search URLs (754) and brand pages (19):**
     - Add paging (`page=1..7`) and `s=date-desc-rank`.
     - Read all organic cards (no limit of 10), only direct children of `div.s-main-slot`, skipping sponsored cards. The logic comes from `apps/backend/src/amazon/amazon-search.ts`.
     - Stop on an empty page, no next link, or page 7.
     - Record `capped: true` when page 7 is full.
   - **Store pages (498):**
     - Walk the store's sub-pages with scroll and load-more, in Ego. The logic comes from `discoverInitialAsins` / `BRAND_STORE_SCRIPT` in `apps/backend/src/amazon/pipeline.ts`.
     - Pages open and close through `EgoTaskPages.using`.
   - **Broker:** allow paged scan URLs for manifest brands, and raise the call cap accordingly.
2. **Manifest builder** script (like `prepare-metrics-rerun-20260928.mjs`; report-only unless `--write`, never queues by itself).
   - Turns scan results into `amazon-link-batch/1` batches.
   - Scope: the brand's enabled `https://www.amazon.com/` root source, as the existing prepare scripts use.
   - `historyListingId`: computed with the same `identifyListing` hash the history store uses, so it is correct for products not yet in the table.
   - Writes the counts per brand: found, already has formula, no formula yet.
3. **No change to the product workflow.** Formula once and the 24h skip already exist for Amazon.
4. **Verification:**
   - Unit tests for paging, the stop rule and the sponsored filter, using the saved search HTML in `docs/quality/evidence/`.
   - One brand end to end on Server 一 (Nordic Naturals): scan, manifest, `crawler-queue add`. Confirm a known ASIN ends `collected` with `reusedFormula: true` and a fresh metrics row, and a new ASIN gets a formula.
   - Then 10 brands including one capped brand, then all.

## Phase 2: Shared groundwork

1. **Migration `025_channels_and_queue.sql`:**
   - Widen the `brand_source` channel CHECK to add `costco` and `wholefoods`.
   - Add generic tables `link_batch`, `queue_control` (one row per channel with its own limits), `queue_item` and `queue_attempt`, each with a `channel` column.
   - Add an index on `collected_product` for the `(listingId, variantId)` lookup.
   - The `amazon_*` tables are not touched.
2. **Channel values** added everywhere:
   - `packages/v3-contracts`: `brands.ts`, `catalog.ts` (scope and `productWorkflow`), `channel-evidence.ts`, `channel-plan.ts`, `text.ts`.
   - `apps/v3-api/src/bootstrap/delivery-config.ts`.
   - `apps/v3-api/src/history/model.ts` (`identifyListing` site rule and the listing channel enum).
   - `apps/v3-workers/src/history-observations.ts` (parser choice).
   - `packages/v3-channels`: `html-evidence.ts`, `commerce-dom.ts`.
   - Web lists under `apps/web/src/v3/`.
3. **Channel-aware product checks.**
   - `inspectExistingFormula` and `inspectRecentAttempt` also match `variantId` and the channel. The channel comes from the owner's `sourceId` → `brand_source.channel`.
   - Amazon and Whole Foods are treated as one ASIN family for the formula check, but not for the 24h skip or metrics.
4. **Generic link batch and queue.**
   - `LinkBatchSchema` with a per-channel address rule in place of `amazonProductAddress`.
   - Queue, runner and CLI take a channel argument.
   - Settlement checks take the channel's workflow type and capture/close activity names from a small per-channel table.
5. **Shared formula-once step.** Move the check out of `amazon-detached-files-workflow.ts` into a helper each product workflow calls behind its own `patched()` marker. Job schemas stay unchanged, because saved jobs are compared for exact equality.
6. **Sibling formula reuse.**
   - When a product has no formula of its own, read its family from the captured page:
     - Amazon: the variation family, as `extractVariationFamily` in `apps/backend/src/amazon/link-check.ts` does.
     - Swanson: the Shopify product's variants.
   - If a family member has a saved formula, save a link record (`formulaReusedFrom`: sibling listing, family evidence) and stop.
   - Reuse applies only when the variants differ by size or pack count (60 vs 120 capsules, 8 oz vs 16 oz), **and the label check passes**:
     - Download only the new size's label image (the Supplement Facts image, not the whole gallery) and OCR it.
     - Compare the OCR text with the saved formula: same ingredient names, same amounts per serving, same other-ingredients list.
     - **Match:** save the reuse link with the OCR evidence, and stop. That's one image and OCR, with no model extraction.
     - **No match, or the label image can't be found:** full extraction as a new product.
   - Everything else gets its own extraction:
     - **Flavour.** The other ingredients differ: flavours, sweeteners, colours. So can the calories and sugars in the facts panel.
     - **Strength or dose,** for example 100 mg vs 200 mg.
     - **Form,** for example capsule vs gummy.
     - **Any difference that can't be read.**
   - Our clients are ingredient suppliers. Our formula stores the other-ingredients list (`otherIngredients` in `packages/v3-contracts/src/label-extraction.ts`), and those are the products some suppliers sell: sweeteners, gelatin vs pectin, natural flavours, colours, capsule shells. Copying a list from another flavour would name the wrong supplier's ingredient.
   - The link record keeps reuse visible and reversible.
7. **Verification:**
   - Vitest for the schemas, the queue and the checks.
   - `pnpm --filter @crawl-automation/v3-workers test:integration` for the queue.
   - Replay of saved Amazon and Swanson histories with `Worker.runReplayHistory`, to prove the patched workflows still replay.

## Phase 3: Swanson

1. Listing scan: a standalone runner around `swanson-catalog-source.ts` for any brand URL (it has paging and end-of-list proof already). Raise the 10-page limit for large brands.
2. Worker: add a link-batch path to `swanson-live-worker.ts`, like Amazon's (`AmazonLinkStore`, `catalogFor`), so it accepts any brand's batch rather than one configured scope.
3. Formula once in `swanson-catalog-workflow.ts` `streamProduct`, after `prepareChannelProduct` and before the label child starts, behind `patched('swanson-formula-once-v1')`. Same in the variant workflow. Add the enrichment call.
4. Brand sources: import the exact-name matches from the saved list of 422 (218 matched) as disabled rows. Loose matches go to a review list.
5. Verification: Healthy Origins end to end (44 products; 2 already have formulas from 09-10).

## Phase 4: Whole Foods

1. Brand URLs: built from the Amazon `p_123` IDs of the 754 verified brands. Each is visited once to confirm the brand is sold there.
2. Listing scan: paged search, product links `/grocery/product/<slug>-<asin>`, ASIN taken from the link.
3. Product task: capture the Whole Foods page for metrics, with the store recorded. The formula is reused by ASIN. An ASIN with no formula gets an Amazon product task.
4. New code: metrics parser for the Whole Foods product page, `WholeFoodsCatalogProductWorkflow`, worker roles, handling of the location prompt.

## Phase 5: Costco

1. Listing scan: category pages with `?refinement=brands%3D<Name>`.
   - Vitamins, Herbals & Dietary Supplements: 58 brands, 210 products.
   - Protein and sports nutrition, and diet and nutrition: brand lists still to read. The same brand may appear in several categories, so product IDs are de-duplicated.
2. New code: product page parser (label images, price, members-only price and warehouse vs online stock recorded as seen), `CostcoCatalogProductWorkflow`, worker roles.
3. Product ID: the Costco item number.

## Phase 6: GNC

1. First re-test site access in Ego. The 09-09 run stopped at a human-verification page (`GNC.ACCESS_CHALLENGE`). If it still blocks, GNC waits.
2. Listing scan: loop `start=N&sz=30` with `parseGncCatalog`.
3. Formula once in `gnc-leased-workflow.ts` after `prepareGncProduct`, behind `patched('gnc-formula-once-v1')`, with `inspectExistingFormula` registered in the `gnc-product-input` role.

## Phase 7: Re-scans (manual only)

No schedules (user decision). The user starts a brand scan for one brand, a list of brands or a channel. The scan adds the result to the queue: known products refresh metrics, new ones get a formula.

## Rules for all phases

- Code lands on `main`. Servers update only with `git pull`.
- Each phase goes 1 brand → 10 brands → all brands, started by hand.
- Workflow changes go behind `patched()` and are replay-tested before deployment.
- Original HTML is archived before parsing. Task-owned pages are closed and verified absent.
- Nothing is imported into the cloud database without a separate instruction.

## Still open

Nothing. All decisions are recorded in the table at the top.
