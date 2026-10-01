# Whole Foods brand scans

The owner-approved default is HTTP JSON through the existing ScraperAPI listing archive and
`BrandListingWorkflow`. Configuration merge fragments for the API, pipeline worker and resource
health worker are in [machines.md](machines.md#whole-foods-http-品牌扫描2026-10-01待-owner-提交与部署).
This is a working-tree change, not a live deployment.

- `brandScans.wholefoods.brandScanMode` defaults to `http`. `browser` retains the existing
  `BrowserScanWorkflow` / `WholeFoodsBrandScan` and page cleanup behavior. Switching is explicit,
  with matching API/worker modes and the corresponding permit queue/health mapping.
- Search-page `k` and `rh` become API `text` and `filters`. The configured store contains the
  cookie identity, `offerListingDiscriminator` (`old`) and `categoryId` (`categories`). JSON does
  not name the store; `metrics.storeId` is request context, not response-verified identity.
- Each read requests size 100 by default, then offsets 100, 200, etc. if required. Each page can
  have at most five tries, separated by two seconds, **only** for valid empty JSON with available
  count zero. HTTP, non-JSON, provider, timeout and archive errors end that read immediately.
  No retry library or new transport was added: this is a bounded source policy using existing
  archive I/O, zod validation and cancellable Node timers. The shared ScraperAPI client is unchanged.
- Two reads, separated by 60 seconds, produce a union in first-seen ASIN order. Each read must
  finish paging, have consistent available counts, and cover that count with distinct ASINs.
  Duplicate offsets or changing counts within a read therefore produce a conservative partial.
  Different totals between the two reads are allowed; `statedTotal` retains the first read's
  available count, never the page heading or approximate count.
- A failed second read retains the first and any observed second-read products, with its own
  error code. Partials never request missing-listing revisits. A first-page empty exhaustion runs
  one logical unfiltered canary page, with the same bounded empty policy. Healthy canary:
  `soldHere=false`, partial (two successful brand reads were not proved), no missing revisits.
  Empty canary: Review with `WHOLEFOODS.SEARCH_THROTTLED`, no `soldHere` assertion. Other canary
  failures keep their own codes. Canary products never enter the brand's queue or union.
- All valid JSON response bodies, including empty ones, use the shared byte-exact R2 archive and
  verified readback before parsing. Labels are `read-1-page-1-attempt-1`, `read-2-…`, and `canary-…`.
  Reattachment reads those exact observations without paying again. Scan result JSON contains
  `metrics.attempts` (cost, archive key, empty/failure status), `metrics.reads` (cards, distinct
  products, available counts, success/code), `metrics.unionSize`, `credits`, and the failure code.
  Reused observations retain their original billed cost; unknown provider costs remain `null`
  per attempt and are not invented in the summed known credits. No database migration is needed.
- The permit remains `wholefoods-brand-scan`, capacity 1, on the HTTP pipeline queue. Every normal
  ending observes `gapAfterSeconds` (default 60). Only exhausted empty tries request
  `cooldownSeconds` (default 1800). Cancellation interrupts waits. The workflow's new
  `brand-listing-cooldown-v1` patch protects pre-cooldown histories and the existing gap patch.
- Product URLs use `/grocery/product/product-<asin>` when the search answer supplies only an ASIN.
  The address module validates that each URL round-trips to the same listing ID. Acceptance on
  the live product route still needs one Mini test; no real-page response is fabricated here.

Before rollout, verify the existing capacity is 1 and private `brandScans.scraperApi.allowedOrigins`
on both API and worker includes `https://www.wholefoodsmarket.com`. Merge with existing entries.
The reader provides the store cookie and JSON headers; the existing client sets `keep_headers=true`.
Run the real Temporal replay suite, PostgreSQL integration checks, one paid brand scan and one
resulting product through the normal API on the Mini before any batch. Nothing auto-starts or
requeues historical Reviews.
