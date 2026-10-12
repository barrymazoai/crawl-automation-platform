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
