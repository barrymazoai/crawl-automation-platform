# Marketplace product sync to Supply Smart (test): plan

> 2026-10-12. Owner: sync completed non-DTC products (Amazon, GNC, Swanson, Whole Foods, Costco) to the Supply Smart
> TEST environment automatically; first only products whose brand already has a Supply Smart company; missing brands
> are created later, then their products follow. DTC keeps its brand-enrichment delivery path unchanged.
> Contract: jakarta `docs/.../07-crawler-ingest-contract.md`, `06-cross-channel-identity.md`, `companies.md`.

## How Supply Smart recognises a product (why the company matters)

A crawler observation is one **listing** (channel + external ID, e.g. Amazon ASIN, GNC SKU). Supply Smart attaches it
to a **product** by: same listing → same GTIN within the company → family `(company, baseName)` → exact
`variant_key` inside the family (veto on different GTIN/form/dosed formula) → exact `(name, company)`. No fuzzy
matching. For marketplace channels the item's `domain` is the **brand's** website (not amazon.com); Supply Smart
resolves the company from it, so a brand without a company cannot join a family and the item fails
`company_not_found`.

## Steps

1. **Brand → company match** (API only). For each crawler brand with completed non-DTC products, call
   `company/resolve({ name })` (plus `domain` when the brand has a DTC source). `matched` → store company ID and its
   website domain; `unmatched` / `ambiguous` → stored as waiting, never guessed, never created here. New crawler table
   `supply_smart_brand_company` (brand_id, status, company_id, domain, matched_by, checked_at). API
   `productSync.matchBrands({ limit })`, `productSync.brands({ status })`.
2. **Mapping** for each channel's completed product → `product/ingestObservationBatch` item: channel, externalId
   (ASIN / GNC SKU / Swanson ID / Whole Foods ASIN / Costco item), sourceUrl, `domain` = matched company website,
   productName / baseName / variant from the existing product enrichment, `variantSource`, capturedAt and commerce
   metrics from the capture history, gallery images, GTIN where the page has one (GNC UPC/MPN, Amazon when shown);
   formula via `product/ingestLabelObservation`. Reuses the DTC delivery modules (mapping, label mapping,
   verification, settlement) generalised by channel instead of a second copy.
3. **Runs**: one `partial` run per channel per sync batch (never `full`: marketplace scans cannot prove a complete
   catalogue), then `verifyObservationBatch` and `completeCrawlRun`. Partial runs never delist anything.
4. **Ledger in the crawler DB**: `product_sync` (channel, listing, variant, collected operation, run ID, Supply Smart
   product/listing IDs, payload hash, status, error). It is what "already synced" means from now on; a product is
   resent only when its collected record changes.
5. **Baseline from the test DB (read-only, one exception, owner 2026-10-12)**: read `product_channel` /
   `crawl_run_item` to find listings already present (earlier imports), record them in the ledger as `present`, so
   the backfill does not resend them. Connection from `.env.supply-smart-test-db`, never in code or git.
6. **Backfill**: `productSync.backfill({ channel, limit, dryRun })` — dry run first (counts per channel and brand),
   then bounded batches of ≤200 items.
7. **Automatic**: a sweep (same pattern as the brand-enrichment redelivery sweep, every 15 minutes) sends newly
   completed products whose brand is matched; products of waiting brands stay waiting and go out once the brand is
   matched.

Layers as ARCHITECTURE.md: SQL and RPC in adapters, mapping/selection in app, sweep in workflows, API in apps/api.
Only decided results go to Supply Smart. No change to capture, labels or the queue.

## Not in this plan

Creating missing brands (later, via the brand-enrichment rules); DTC delivery; production Supply Smart.
