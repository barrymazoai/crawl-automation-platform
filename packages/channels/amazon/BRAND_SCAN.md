# Amazon search brand scans (R18)

Implemented in the permitted files. API registration and Amazon queue repository wiring remain
outside this ticket's edit boundary; this is not a deployed or live-tested scan service.

## Behavior

`amazonAdapter.brandScan` exports `amazonBrandScan`, a `BrandScanReader` for verified `/s` Brand
filters and the 19 `/s?srs=...&rh=p_89:...` brand pages. Store pages, root URLs, keyword-only
searches and Seller filters are rejected. Search scope is retained, tracking is removed, and
requests carry `s=date-desc-rank` and `page=1..7`.

The existing application `ListingPageReader`/core `ListingPages` performs ScraperAPI capture and
archive verification before parsing. This reader performs no HTTP or browser operations itself.
Only direct `div.s-main-slot` child search-result cards with ASINs are considered. Sponsored
labels/text/links, AdHolder and ad-feedback markers are excluded. Nested recommendation cards
are excluded. Product title links take precedence over brand-only headings. All organic cards
are read, with products deduplicated by ASIN. The old ten-result sample limit is not retained.

An empty organic page, absent next link or page 7 stops paging. A full seventh page is capped
even without a next link. Result range positions accommodate 24- and 48-card layouts without
using the estimated total as completeness proof; an unreadable range on a populated seventh
page is conservatively capped. A short terminal seventh page with a usable range is not capped.
Removing advertisements never makes a full displayed seventh page appear short.

Selected Brand checkboxes and pagination are checked against the request. A lost filter,
repeated first page, malformed organic ASIN, robot check or missing search grid fails explicitly.
The srs brand-page shape does not require a search-only checkbox.

`capped` is preserved in the application result and Postgres JSON decoding. Capped results are
partial (`full=false`), queue their discovered products, and never request missing-product
revisits. Every other partial result also retains the existing no-revisit guard.

## Amazon's existing queue

`AmazonBrandScanQueue` converts products to validated `amazon-link-batch/1` inputs, at most ten
entries per batch. Campaign, candidate and request IDs are stable across resumption; history
identities use the application's existing `identifyListing`. It does not submit Amazon products
to the non-Amazon `{ products }` queue contract.

The bridge accepts three dependencies: `queue`, `scopeFor(scan)` and `knownListings(scan)`.
`scopeFor` must resolve the brand's enabled US root source, including its exact deployed scope
version, and retain that scope across resumption. It must not substitute the search source as
the product execution source. `knownListings` must query Amazon's queue/history and exclude
the scan's own campaign. Full-scan revisits use the same bridge with the scan's fixed revisit
campaign ID. A runner without `amazonQueue` fails before reading any page.

## Files changed

| Area                                          | Files                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Amazon implementation                         | `src/brand-scan-address.ts`, `src/search-cards.ts`, `src/brand-scan.ts`, `src/adapter.ts`, `src/index.ts`, `src/errors.ts` |
| Amazon tests and data loader                  | `src/brand-scan.test.ts`, `src/testing/saved-search-pages.ts`, `src/address.test.ts`                                       |
| Application (`packages/app/src/brand-scans/`) | `scan-model.ts`, `scan-listing.ts`, `brand-scan-runner.ts`, `amazon-scan-queue.ts`, `index.ts`                             |
| Application tests                             | `brand-scan-runner.test.ts`, `brand-scan-service.test.ts`, `amazon-scan-queue.test.ts`                                     |
| Postgres (`packages/adapters/src/postgres/`)  | `brand-scan-queries.ts`, `brand-scan-amazon.test.ts`                                                                       |
| Migration                                     | `database/v3/032_brand_scan_amazon.sql`                                                                                    |
| Documentation                                 | This file and `README.md`                                                                                                  |

No old migration, dependency manifest, depcruise baseline, other agent's import line, or saved
HTML was edited. No branch, commit, install, deployment or network request was made.

## Saved pages

Both real originals are read from
`docs/quality/evidence/2026-09-23-brand-scraperapi-check/`:

| File                        | Use                                                                 | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `02-filtered.original.html` | 24 organic cards, real titles, ASINs, selected Brand and pagination | `7a2697c88af9c227b6aaa897d78ecf5c27feb5b42c0352215613dc7992825886` |
| `01-search.original.html`   | Real keyword-only response must fail a requested Brand-filter scan  | `2909fef5b9291417b31d2cc56a67023e858d92c19f06f4285cb53040f047d888` |

Hashes match the retained receipts. Sponsored variants, empty/terminal/seventh pages and the
srs shape are explicitly in-memory mutations of these originals, not claimed real captures.
The category-check directory contains JSON observations, not additional HTML originals.

`V3_TEST_DATA_DIR` accepts basenames or repository-relative paths through the existing saved-page
helper. An explicit override disables repository fallback. Missing files use `describe.skipIf`
with a message naming the missing file and the variable. No saved data was added to git.
The broader Amazon regression suite also uses the five product pages documented in `README.md`.

## Verification

Final checks used the original repository configurations: TypeScript passed for Amazon, app
and adapters. Vitest passed 165 tests across 12 files (Amazon 135, application 27, adapter
catalog/decoding 3), with 2 opt-in PostgreSQL tests skipped. ESLint passed on the changed code;
jscpd found zero clones across 115 inspected source files. The missing-data run passed 19
independent address tests and skipped 22 saved-page tests with the explicit missing-file message.
No temporary resolver override is required by the final successful checks.

Use the installed executables in `node_modules/.bin/` (no install or network needed):

```sh
./node_modules/.bin/tsc --noEmit -p packages/channels/amazon
./node_modules/.bin/tsc --noEmit -p packages/app
./node_modules/.bin/tsc --noEmit -p packages/adapters
./node_modules/.bin/vitest run --config vitest.v3.config.ts packages/channels/amazon packages/app/src/brand-scans packages/adapters/src/postgres/brand-scan-amazon.test.ts
./node_modules/.bin/eslint packages/channels/amazon packages/app/src/brand-scans packages/adapters/src/postgres/brand-scan-queries.ts packages/adapters/src/postgres/brand-scan-amazon.test.ts
./node_modules/.bin/jscpd --config .jscpd.json packages/channels packages/app/src/brand-scans packages/adapters/src/postgres/brand-scan-queries.ts
```

The migration/catalog tests verify discovery of 032 after 031, its hash, capped-result decoding,
and historical results without capped. Real Postgres tests are opt-in with `V3_TEST_POSTGRES=1`;
they use the existing temporary Unix-socket helper, never a configured database or TCP listener.
Initialization was attempted here but sandbox `shmget: Operation not permitted` prevented it.
The SQL has therefore not been executed against PostgreSQL in this task.

The migration loader discovers and sorts `.sql` files automatically, so no ordered list edit
is necessary. The existing catalog test still hardcodes 31 files and last file 031; its one
assertion fails after adding 032. Its other 13 tests pass. That test is outside the edit boundary.

## Remaining integration outside the allowed files

1. Add `amazonAdapter` to `apps/api/src/brand-scan-parts.ts`'s scan registry and the API/worker
   product registries described in `README.md`, with their workspace dependencies.
2. Wire `AmazonBrandScanQueue` into the scan runner with repositories resolving the enabled root
   scope and Amazon known listings. Keep the scope stable across scan resumption. The current
   `PostgresBrandScans.knownListings` reads only the shared queue.
3. Extend revisit-outcome reading to Amazon campaigns: the current `PostgresBrandScans.revisits`
   query only counts shared-queue runs. Amazon revisit counts must not be presented as verified
   until this is wired.
4. Update `packages/adapters/src/migrations/sql-catalog.test.ts`'s count/last-file expectation.
5. Run the opt-in PostgreSQL tests and an authorized Mini acceptance scan before deployment.

The Store-page scanner remains a separate browser ticket. Nothing here enables sources,
starts scans, or changes intake.
