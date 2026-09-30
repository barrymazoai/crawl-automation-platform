# Amazon Store browser scans (R19)

The Store reader and worker composition are implemented within the ticket's permitted files.
Production API integration still requires the changes listed below. No browser, network,
installation, deployment, branch, commit, or source-data mutation was performed.

## Behavior and stop proof

`AmazonStoreBrandScan` uses `AmazonStorePages` to visit the source and its observed Store
navigation graph. UUID page identities deduplicate slug aliases and tracking URLs. Only Store
navigation links are followed; external links, searches, product links and explicitly different
Store slugs are excluded. All 498 recorded Store source addresses pass normalization.

The page driver uses Ego's SDK to navigate, scroll by viewport increments and click visible
load-more controls in product-grid modules. Product identities come from Store product tiles,
including their data-ASIN attributes and `/dp/` or `/gp/product/` links. Global product links
and Amazon navigation are excluded. Products are deduplicated within and across sub-pages.

A page has a stop proof only after three consecutive settled rounds with no new ASINs or
navigation links, no change in physical tile count, no load-more control, no loading indicator,
and the viewport at the bottom. Disabled load-more controls still count as loading. The scroll
budget is 60 rounds; the navigation budget is 100 pages. Hitting either budget yields a partial
scan. `complete` is true only when every discovered sub-page was visited and each has a valid
stop proof. The application also requires `soldHere` before marking its result `full`.

Every new observation is retained when identities, tile count, navigation, URL or status change;
the terminal HTML is also retained. This preserves virtualized tiles that disappear before the
last scroll. Exact rendered HTML strings, capture URL/time/status, byte sizes, SHA-256 hashes and
scroll proof are kept in immutable `amazon-store-scan/1` JSON records under
`v3/brand-scans/<scanId>/store-<url-hash>.json`. These are browser DOM snapshots, not HTTP response
originals. Local retention and R2 publication/read-back use the existing `RetainedPublication`.
Business parsing follows successful archive verification. Replaying a scan uses the archive;
an uncertain publication stops rather than opening another page.

Each sub-page gets a fresh task-owned page. The Store round closes it on success, source failure
or cooperative cancellation and checks its exact target ID up to four times. A cancelled or
killed executor is awaited before exact-target recovery with a fresh 20-second signal. Recovery
first checks absence without closing again. User control remains a hard stop; an unverified or
denied close remains `BROWSER.PAGE_CLEANUP_PENDING`. Unrelated tabs and the browser profile are
not touched. Tests execute the actual lifecycle scripts against a fake task-space SDK.

## Files

Under `packages/channels/amazon/src/`:

- `store-address.ts`: Store URL validation and navigation filtering.
- `store-dom.ts`, `store-listing.ts`: tile/navigation projection and browser `BrandScanReader`.
- `store-scroll.ts`, `store-page-browser.ts`: typed exhaustion logic and Ego page actions.
- `store-archive.ts`, `store-scan.ts`: verified originals, graph traversal and full/partial result.
- `errors.ts`, `index.ts`: registered errors and public exports.
- `store-listing.test.ts`, `store-scroll.test.ts`, `store-page-browser.test.ts`,
  `store-scan.test.ts`, `testing/store-fakes.ts`: offline tests and synthetic in-memory drivers.

Under `apps/worker/src/browser/`:

- `browser-parts.ts`, `scan-wiring.ts`, `browser-scanners.ts`: capability-selected composition.
- `store-rounds.ts`, `managed-rounds.ts`: page lifecycle, cancellation recovery and absence checks.
- `browser-scanners.test.ts`, `managed-rounds.test.ts`: composition and lifecycle tests.

`packages/app/src/brand-scans/scan-model.ts`: only the browser channel list, adding Amazon.
The capability-compatible browser workflow required no change. This report is `STORE_SCAN.md`.

## Saved data and verification

No Store HTML exists in the searched `docs/quality/evidence` and `apps/v3-workers` trees, including
ignored files. The Shop All captures there are JSON observations, not HTML. The optional real
Store-page regression looks for `amazon-store.html` in `V3_TEST_DATA_DIR`, or at
`docs/quality/evidence/2026-09-23-shop-all-check/amazon-store.html`, and explicitly skips if absent.
No synthetic page is written as a saved fixture or represented as a real capture.

The real `docs/quality/evidence/2026-09-24-brand-final-status.json` supplies the 498-address test.
The existing Amazon regressions also read the two search originals in
`2026-09-23-brand-scraperapi-check`, the three product HTML files in
`2026-09-23-amazon-html-loading`, and the two existing gzipped product originals documented in
`README.md`. The existing `V3_TEST_DATA_DIR` override is honored for all those loaders.

Verification used installed executables, without invoking package installation or networking:

- `tsc --noEmit -p` passed for Amazon, worker, app and workflows.
- The requested Vitest selection passed **208 tests across 14 files**, with **1 skipped**
  (missing Store HTML). New Store/worker tests account for 65 passes and that one skip.
- A missing-data override run of `store-listing.test.ts` passed 12 tests and skipped both saved
  data tests, proving the override does not silently fall back to repository evidence.
- ESLint and Prettier passed on the edited code; `git diff --check` passed.
- Repository-configured jscpd inspected 442 governed source files and found zero clones.

## Required integration outside the edit boundary

1. `packages/app/src/brand-scans/scan-readers.ts` must choose capture by source URL capability.
   The current `BROWSER_SCAN_CHANNELS` is channel-wide: adding Amazon allows the browser path,
   but also routes Amazon search sources there. Store URLs must use the browser reader while
   `/s` sources keep `amazonAdapter.brandScan` and its existing HTTP path. Do not enable this
   channel-list change in production before that source-based selection is connected.
2. `apps/api/src/brand-scan-parts.ts` must register Amazon's HTTP adapter and Store browser
   gateway (`amazonStoreSourceUrl` plus `TemporalBrowserScans`), and wire the Amazon queue bridge
   described in `BRAND_SCAN.md`. Its current browser gateway registers Whole Foods only.
3. `apps/worker/src/activities/browser-activities.ts` currently discards the validated channel
   before calling the scanner. URL capability selection works with that existing signature;
   retaining channel/capture in the call would additionally allow rejecting mismatched requests.

Before a batch, run an authorized single Store acceptance scan on a Mac mini. Verify the live
Store navigation/tile selectors, sibling load-more controls, lazy loading and scrolling, hidden
navigation sub-pages, original R2 read-back, and exact target absence after success, source
failure and activity cancellation. Also verify user takeover leaves cleanup pending. Neither
Mini was contacted here, so runtime readiness or deployment on either machine is not claimed.
