# Marketplace formula-once label reuse

The marketplace reader now retains its current-run collection preference, then uses the pipeline's existing
`FormulaLookup` / `PostgresFormulaIndex.findKnown` when no collection belongs to that run. It passes the captured
product's owner identity and `formulaFamilies` from the injected ChannelRegistry. This reads both direct collections
and `formula_link` without copying their lookup SQL. Whole Foods uses this same fallback, including when the latest
Amazon run also reused a formula. An actual lookup miss still produces an item without a label.

This supersedes the current-run-only label rows in [the original mapping report](2026-10-12-marketplace-mapping.md).
It is a local code change against `main` / `d2219b7`, not a deployment or a live smoke-test result.

## Where the pipeline's owner comes from

`collectCapturedProduct` passes `sourcePlan.owner.listingId/variantId` to `findKnownFormula`.
`ProductSourcePlans.planInput` obtains that owner from `parsed.identity`, not from the queue identity or commerce SKU.
The reader loads the exact run/source/page/variant capture-history record, verifies its hash, reads the retained
page bytes referenced by `history.evidence`, verifies SHA-256, and calls the same channel's pure `parseProduct`.
It requires parsed identity and returned product evidence to agree. Standard retained projections already carry
these fields. No live page fetch, Temporal history fetch, OCR or model call is introduced.

| Channel | Formula owner recovered from retained material | Formula family |
| --- | --- | --- |
| Amazon | Parsed page ASIN, null variant (`parseAmazonProduct`). | `amazon-asin`: Amazon and Whole Foods |
| GNC | Page SKU from `gncPageIdentity`, null variant. | GNC only |
| Costco | Parsed evidence's online listing ID and selected child variant (or null). | Costco only |
| Swanson | `selectedIdentity` → `swansonIdentityMapping`: Shopify product ID and the selected form's Shopify variant ID. | Swanson only |
| Whole Foods | Its own retained page's ASIN/null variant, matching the formula-family capture identity. | `amazon-asin`: Amazon and Whole Foods |

The real Swanson sample distinguishes all three namespaces: queue handle
`country-life-core-daily-1-women-50-60-tabs`, history commerce SKU `CRL530`, and formula owner
`8572216246410 / 46318742077578`. Neither handle nor SKU is substituted for the formula key. A history capture variant
of null describes a URL without an explicit selection; it does not erase the selected variant in the parsed page.
The supplied sample records preserve that original collection owner; the HTML parser test uses an explicitly marked
test double because these samples provide original-object references, not HTML bytes.

## Linked ownership, time and commerce

The former Whole Foods label path is generalized through `linkedLabel`: resolved target key, collection operation,
and the donor's own capture history/product evidence. The collection is read by the exact operation returned by the
index, verified using `checkedCollectedProduct`, and checked against its actual brand-source channel/family. Its
history hash and retained page hash are verified. Mapping checks donor run/source/brand, page, listing and selected
variant against the collection. Ambiguous donor histories fail explicitly.

The label identity hashes channel + target capture observation + linked collection operation, remains independent of
the Supply Smart batch, and retains the donor's original capture time and original observation in `extras.labelSource`.
Sibling links use the target listing/variant in the outgoing label observation. Label calls omit commerce; batch
items use the target's own history and gallery. A sibling formula never supplies another variant's name/size enrichment.
The same-ASIN Whole Foods label keeps its previous identity hash and observation prefix.

`PENDING_SYNC` and `PostgresProductSync` are unchanged. Recovering the authoritative Swanson owner can require reading
and parsing retained object material, so a reliable cross-channel “formula now resolvable” predicate is not cheap SQL.
Per the task's allowed fallback, already verified smoke rows with `collected_operation_id IS NULL` are not automatically
reopened by this patch. No ledger rows were changed.

## Changed files

- Adapters: `product-sync/marketplace-materials.ts`, `marketplace-queries.ts`.
- Application: `product-sync/marketplace-model.ts`, `marketplace-mapping.ts`, `marketplace-ownership.ts`;
  `formula/formula-lookup.ts` only widens the registry parameter to its required `get`/`channels` methods.
- Tests: new `marketplace-materials.test.ts` and `marketplace-formula.integration.test.ts` beside the reader;
  updated `marketplace-reader.fixture.ts`, `marketplace-reader.integration.test.ts`, and `marketplace-mapping.test.ts`.
- This report. DTC implementation and its tests are unchanged.

## Validation

- App and adapters `tsc --noEmit` passed; changed TypeScript passed ESLint and Prettier.
- 84 unit tests passed: 10 new material cases, 22 marketplace mappings, 7 formula-family lookup cases,
  3 existing formula-index cases, and 42 unchanged DTC delivery cases.
- Tests use `CRAWLER_MARKETPLACE_SAMPLES` outside git; sample-dependent suites were also checked with the variable
  absent and skipped successfully. Synthetic later captures, siblings and projections are explicitly test doubles.
- PostgreSQL integration tests: run by the main session on a local throwaway PostgreSQL with
  `CRAWL_TEST_DATABASE_URL` and `CRAWLER_MARKETPLACE_SAMPLES` set — 12 passed (3 consecutive runs), 2026-10-12.
  Command:

```sh
pnpm --filter @crawl-automation/adapters exec vitest run \
  src/product-sync/marketplace-reader.integration.test.ts \
  src/product-sync/marketplace-formula.integration.test.ts
```

The added integration case uses the actual formula SQL for prior-run collections, distinct donor/target sources,
Swanson numeric owner resolution, exact variant misses, and a persisted `formula_link`. The existing case retains
Whole Foods coverage. No commit, branch, deletion, production query, database mutation or Supply Smart call was made.

## Smoke follow-up against f8e957b: retained Swanson owner and observation-only delivery

The reported smoke failed two Swanson products with `PRODUCT_DELIVERY.MATERIAL_MISSING`. The supplied A.C. Grace
original HTML was read locally, without a fetch. Its 1,007,089 bytes match the accompanying metadata's SHA-256
`460d0e880930b13b1a691a7f31a749aeeb8e04fbd074b41fc4bdb260fec6b8f7`.

The suspected cause needs a correction: **before this follow-up's changes**, `swansonAdapter.parseProduct` already
parsed this HTML to Shopify owner `8572156346506 / 46318677426314`, title
“Unique E High Gamma Mixed Tocopherol Concentrate” and commerce SKU `ACG002`. The HTML branch of the marketplace
reader already called this parser without a collection. The collection-dependent branch was only for nonstandard
JSON projections, so that branch cannot explain failure on these exact HTML bytes.

Two concrete material-handling gaps are addressed:

- A saved Swanson JSON projection could not be decoded without a collection. `ChannelPlanning.identity` is now an
  optional hook, implemented by Swanson using the same `selectedIdentity` → `swansonIdentityMapping` as capture.
  It validates the existing `SwansonRenderedProductSchema`; `planning.read` still checks the expected URL and
  selected owner. No new HTML parser, numeric-ID regex or queue-handle/SKU substitution was introduced.
- A formula-index hit followed by missing **donor** history or retained page used to throw the same
  `MATERIAL_MISSING` as a missing **target** page. Only that explicit donor absence now leaves the target's own
  verified product/history intact, with no label or borrowed enrichment. `unavailableLabel` preserves the indexed
  operation and error code in the mapped item's extras. Hash/ownership conflicts, ambiguity, parser failures,
  infrastructure errors and cancellation still fail explicitly; no invalid label is sent. A genuine index miss
  remains an ordinary observation-only item.

The live donor histories/objects and deployed process were not queried in this follow-up, so the exact live failing
stage is **not confirmed**. Donor-material absence is a demonstrated code path, not a claimed production finding.
The second failed Swanson page was not supplied and has not been independently reproduced.

Owner recovery without a collection remains channel-owned:

| Channel | Original HTML | Retained projection |
| --- | --- | --- |
| Swanson | `parseProduct` → `parseSwansonStaticHtml` → `selectedIdentity` → `swansonIdentityMapping`; Shopify product/selected variant | New optional planning hook calls that same identity function, then existing `planning.read` validates it |
| Amazon | Existing `parseAmazonProduct`; page ASIN/null variant | Existing standard evidence listing/variant |
| GNC | Existing parser and `gncPageIdentity`; SKU/null variant | Existing standard evidence listing/variant |
| Costco | Existing parser; online listing and selected child/null variant | Existing standard evidence listing/variant |
| Whole Foods | Existing parser; own page ASIN/null variant | Existing standard evidence if supplied; no new planning hook |

`FormulaLookup` and `PostgresFormulaIndex.findKnown` are still the only formula lookup path. No SQL changed or was
duplicated. DTC implementation is unchanged; no queue or sync ledger is reopened by this change.

Changed files for this follow-up:

- `packages/channels/core/src/adapter.ts`, `packages/channels/swanson/src/adapter.ts`: optional projection identity
  hook and Swanson implementation.
- `packages/adapters/src/product-sync/marketplace-projection.ts` (new), `marketplace-materials.ts`: retained decoding
  and bounded handling of unavailable donor material; `marketplace-materials.test.ts`: absence/integrity regression cases.
- `packages/app/src/product-sync/marketplace-model.ts`, `marketplace-mapping.ts`, `sync-send.ts`,
  `sync-service.test.ts`: retain the missing-donor reason, clarify observation-only sending, exercise real service
  ingest/verify calls against a fake writer for all five marketplace channels.
- `apps/worker/src/marketplace-retained-swanson.test.ts` (new): composition-level offline tests with the actual
  Swanson adapter and marketplace reader. Located in the composition package, which already depends on both;
  no dependency or layer exception was added.
- This report.

Real-page test inputs stay outside git. Set `CRAWLER_SWANSON_ACGRACE_PAGE` to the supplied `.html`; the test reads
the adjacent `.json` metadata and verifies byte size/hash. It tests both the original bytes and a projection
generated by the production parser, asserts the exact formula lookup parameters, verifies a lookup miss maps the
own title and price `47.29` without a label, and rejects missing/corrupt bytes or the wrong requested variant.
Database rows and formula misses in these tests are explicit doubles; no live database/formula claim is made.

```sh
CRAWLER_SWANSON_ACGRACE_PAGE=/path/to/swanson-acgrace-original.html \
  pnpm --filter @crawl-automation/worker exec vitest run src/marketplace-retained-swanson.test.ts
```

The real-page suite skips when this variable is absent. The eight new observation-only service unit cases run
without either sample environment variable. PostgreSQL integration checks remain assigned to the main session.

Follow-up validation completed locally:

- 174 tests passed across 18 suites, including the six actual-page cases, 13 marketplace-material cases,
  15 sync-service cases, formula lookup/index and mapping regressions, Swanson capture/planning regressions,
  and all 42 unchanged DTC delivery cases.
- With both sample variables absent: eight synthetic service cases passed; 26 sample-dependent cases skipped.
- `pnpm --filter <pkg> exec tsc --noEmit` passed for `@crawl-automation/app`, `@crawl-automation/adapters`,
  `@crawl-automation/worker`, `@crawl-automation/channels-core`, and `@crawl-automation/channel-swanson`.
- Changed TypeScript passed ESLint and Prettier. `pnpm check:deps` passed (two existing baseline violations ignored);
  `git diff --check` passed.
- No commits, branches, file deletions, deployments, database changes, fetches or Supply Smart calls were made.
  Existing/concurrent edits elsewhere in the workspace were left untouched.

## Owner decision 2026-10-12: the formula index is the link; no donor capture page

The second smoke (08a38a4) sent both A.C. Grace products without a label. Their formula (operation
`label-8572156346506-channel-label-bf6da32a-…` and 6 others) was collected 2026-09-10…13 by runs that wrote no
`v3-capture-history/1` record. Across marketplace channels, collections without capture history: Amazon 13,430 of
18,094 (collected 2026-09-14…09-28), GNC 2, Swanson 12, Costco 0. The reader therefore dropped the label of every
product whose one formula came from those runs.

Owner: the database association already says which formula belongs to which product; always send the product's one
formula. The reader no longer reads the donor's capture history or retained page:

- `FormulaLookup` (unchanged) resolves the operation; `MARKETPLACE_LINKED_COLLECTION` reads it with its channel and
  `collected_at`. The record hash (`checkedCollectedProduct`) and family-channel checks remain.
- `linkedLabel` carries `{ target, operationId, channel, capturedAt }`; the label's `capturedAt` and
  `extras.labelSource.capturedAt` are the formula's `collected_at`.
- Ownership rechecks only the exact operation and the target listing/variant. The removed checks compared the donor
  page against the same association the index already provides.
- `unavailableLabel` and `MARKETPLACE_LABEL_HISTORY` are removed (no remaining path).
- `productSync.reopen({ withoutLabel: true, channel?, limit })` re-pends verified rows with no
  `collected_operation_id` (sent without a formula). Products with no formula anywhere are re-sent once, harmlessly.
