# Amazon verified observed page URL: repair and fresh Temporal acceptance

The original-image download now binds to the actual page URL in the verified retained Amazon capture. An Amazon-added `?th=1` no longer prevents downloading the same selected product's gallery. Task URL/target mismatches return `SOURCE.SESSION_MISMATCH` before switching or fetching; an unverified response URL returns `ARTIFACT.INTEGRITY`.

`AmazonLiveProduct.filePageUrl` reads the retained intent and projection, validates Amazon origin and ASIN, reconstructs the source hash/owner/session binding, and compares the complete capture input before returning its observed URL. The original `expectedUrl`, workflow contracts, queue routing and retained historical fingerprints remain unchanged. Exact target/URL checks, redirect rejection, image byte limits and page cleanup remain enforced.

## Validation and deployment

- Source fix commit: `53432be4416dc3cc1e5334c0f150587cef6e8df3`, pushed to `main`.
- Worker type checking passed.
- Mini regression suite: 68 passing tests in three files, including changed query, foreign target/product/origin, missing/duplicate target, navigation between inventory and evaluation, altered retained evidence, cold historical inspection, unchanged image bytes and page cleanup.
- Actual Mini release: `/Users/barry/apps/crawlv3-batch-a.UiA4dx/release-amazon-page-binding-20260913`.
- Activity build: `b3bb8e7bd190c0bb05e9fee157da692a042c8fb940c71b3d7224f069f650bb15`.
- Seven Amazon Workers restarted individually and verified against the release/build; main monitor PID `68275` and unrelated Worker PIDs unchanged. All 90 main jobs ready after deployment.
- Windows and other channel releases were not replaced. Credentials were retained privately on Mini.

The private Amazon configuration preserves all 511 existing link batches and appends one new single-product acceptance request. Each Amazon role was restarted once to load that request and the new release. No previous Review was retried or reset, and the cancelled ten-/2,000-product campaigns were not resumed.

## Fresh business acceptance

The normal Brand API accepted one CoQ10 product (HTTP 202), and its existing Temporal workflows executed the collection:

- ASIN: `B0GBX7416D`.
- Request: `9d2ae9d0-f953-49fb-bdbe-28a560177f93`.
- Brand workflow: `v3-collection-9d2ae9d0-f953-49fb-bdbe-28a560177f93`.
- Product workflow: `catalog-product-30b2894ca44635e077a8ae9c03aa59fd02237ee3f3e38b819814deecf697463d`.
- Delivery setting: New York 10001.

All seven image Activities returned durable receipts, including the previously failing first original: 176,130 bytes, SHA-256 `a9ed8ab8446cb47a7541a1b427a693c2ce5e71c4d7b9ecdf3c5bdde98cd8b4be`. The normal capture Worker then closed exact task target `416598160D336FD9D18C4CAE6FD8F4A9`. This validates the installed Worker through the normal Temporal flow, not only the isolated diagnostic transport.

Closeout at 15:44 UTC confirmed the Brand, product and label workflows all completed. All seven original R2 files were read back and verified against their receipt sizes and SHA-256 values. Their dimensions are 1393×1500, 1445×1500, 1499×1500, 1499×1500, 1500×1500, 1499×1500 and 1500×1500. The retained page URL includes `?th=1`, while the original expected URL remains unchanged.

The opened/closed page journals match the Temporal close receipt. Three current read-only inventories confirmed the exact target absent. Held permits and source intake guards for the new request are both zero. No task remains running for this acceptance.

The image download defect is separate from label quality. The final product outcome is Review with `LABEL_PRODUCT.FORMULA_CONFLICT` and `TEXT.CITATION_INVALID`; the two retained Reviews remain available. This acceptance passes the download/retention/cleanup repair, not complete product/label quality acceptance.

Mini evidence directory: `/Users/barry/apps/crawlv3-history-20260913/amazon-page-binding-20260913`.

[Deployment receipt](evidence/2026-09-13-amazon-page-binding/deployment.json), [regression results](evidence/2026-09-13-amazon-page-binding/tests.json), [full closeout](evidence/2026-09-13-amazon-page-binding/closeout.json), [health after acceptance](evidence/2026-09-13-amazon-page-binding/health.json).
