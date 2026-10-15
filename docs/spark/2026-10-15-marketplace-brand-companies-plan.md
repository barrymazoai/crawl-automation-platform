# Marketplace brands without a Supply Smart company: plan

> 2026-10-15. Owner: reuse the brand import (brand enrichment) to give the brands whose marketplace products could not
> sync a Supply Smart company; only the identity part (official website → find or create the company), largest
> brands first (top 50), then the existing product-sync sweep sends their products. Follows
> [2026-10-12-marketplace-product-sync-plan.md](2026-10-12-marketplace-product-sync-plan.md) ("Creating missing
> brands later, via the brand-enrichment rules"). Status: **plan, waiting for owner approval; no code yet.**

## Where we are (read-only checks, 2026-10-15)

- 15,809 completed marketplace products; 12,403 belong to 413 brands that matched a company and were synced.
- 318 brands (3,426 products) are waiting: 315 `unmatched`, 3 `ambiguous`. Top 20 brands = 1,802 products, top 50 =
  2,360; 121 brands have only 1–2 products. By channel: Swanson 1,406, GNC 1,385, Amazon 385, Costco 128, Whole
  Foods 121.
- `productSync.matchBrands({ limit: 500, recheckUnmatched: true })` run again today: 318 checked, **0 new matches**.
  Name matching alone cannot close the gap; none of the 318 has a DTC website in our database.
- Brand enrichment ran only on 2026-10-09 (9 completed, 5 failed, 7 cancelled). Its only entry is a Supply Smart
  brand request (`start({ requestId })`), and our key cannot create requests. Its identity step needs the request's
  `brandUrl`; without one it falls back to the name, which is exactly what failed above.

## What is missing, and what is reused

The one new piece is **finding the brand's official website**. Everything after that is the existing identity rule
(`BrandIdentityService` / `resolvedCompany`): `resolveDomain(domain)` → `matched` = existing company, take its id and
change nothing in Supply Smart; `unmatched` = `company.create({ name, website, isNutrition: true })`; `ambiguous` = no
choice, the brand stays waiting with the candidates recorded. Never merge.

| Piece | Layer / folder | Reuses | New code, and why |
|---|---|---|---|
| Website lookup task: brand name + up to 5 of our own product names/URLs for that brand → official site or none | `packages/processing/src/brand-research` | `BrandCaptureRunner`, `browserPrompt` (Ego page lifecycle, saved originals with hash, receipts), page grounding (`quotedPage`) | One prompt + answer check: the cited homepage must be saved, its domain must equal the answer's domain, and the quote (brand name / matching product) must be on the page. Marketplace and reseller domains (amazon, walmart, iherb, vitacost, …) are refused as an official site; a retailer's own house brand (GNC → gnc.com, Kirkland Signature → costco.com) is accepted when the page proves it |
| Answer shape | `packages/v3-contracts/src/brand-enrichment.ts` | zod, `EvidencePageSchema` | `BrandWebsiteSchema` { url \| null, quote, evidence, reason } |
| Run record | `database/v3/063_brand_enrichment_marketplace.sql` | `brand_enrichment_run` table | New role `marketplace` (no Supply Smart request, no parent) and nullable `brand_id` → `brand(id)`; one live run per brand |
| Service | `packages/app/src/brand-enrichment` | identity rule above, run records, errors | `MarketplaceBrandService`: pick waiting brands from `supply_smart_brand_company` (unmatched/ambiguous) ordered by product count, create runs, start workflows; after identity write `supply_smart_brand_company` = `matched`, `matched_by: "website"`, company id + domain. Close skips the Supply Smart request update (no request) |
| Workflow | `packages/workflows/src/brand-enrichment-workflow.ts` | same workflow, same close path, same `resourceGate` | For role `marketplace`: website lookup (gated: Ego space 17 + model permit) → identity → write match → close. No family, research, Apollo, products, contacts, ownership |
| Activities / worker wiring | `apps/worker` | existing brand-enrichment role and queue `v3.brand-enrichment` | Two activities |
| API | `apps/api/src/routers/brand-enrichment.ts` | existing router | `brandEnrichment.startMarketplaceBrands({ limit, brandIds? })`; results visible in the existing `list` / `get` and in `productSync.brands` |

Once a brand is `matched`, nothing new is needed for products: the existing 15-minute product-sync sweep sends its
waiting products (`PENDING_SYNC` only requires the brand's match), and `matchBrands` never rechecks a matched brand.

## Outcomes per brand

| Result | What happens |
|---|---|
| Website found, Supply Smart has the company | Link only (record company id + domain); Supply Smart unchanged; products sync |
| Website found, Supply Smart has no company | Create the company (name + website, nutrition); products sync |
| Website found, Supply Smart ambiguous | Stays waiting; candidates stored; listed for a person |
| No official website / not a nutrition brand / blocked page | Stays waiting with the reason; nothing created |

New companies are bare (name + website). Their profile, Apollo people and DTC products can be added later by a full
brand-enrichment run if the owner wants it; not in this plan.

## Order and checks

1. Code → `pnpm check` → independent review against ARCHITECTURE.md and the rules; commit to `main`, push, deploy
   with `ops/deploy` (`--migrate` for 063).
2. **One real brand first** (Carlson, 121 Swanson products), check the run, the Supply Smart company and that the
   sweep sends its products.
3. Then the top 50 by product count in one call. They queue on the single Ego space 17, one at a time (estimated
   2–5 minutes each, so a few hours). Report: linked / created / still waiting with reasons, and products synced.
4. The remaining ~268 brands (about 1,060 products) only when the owner says so.

Supply Smart target stays **TEST** (`test.supplysmart.net`), as for the product sync.

## Not in this plan

Full brand enrichment (profile, Apollo, sub-brands, DTC products) for these brands; production Supply Smart; any
Supply Smart code change.
