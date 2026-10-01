# Whole Foods identity and catalogue acceptance

R62 local inspection found no real retained product HTML with `storePreference` in the evidence or
scratch directories. Existing fixture HTML is synthetic. Identity tests build JSON at runtime.
Supported selected-product paths are `product.asin`, `pageData.product.asin`, and
`props.pageProps.product.asin` in JSON scripts. They do not search recommendations, accept the
requested URL as proof, or infer an ASIN from a title. Missing/ambiguous proof refuses metrics;
a proved different ASIN yields an unlisted `identity_conflict` before parsing.

Before live acceptance on a Mini, inspect one retained original for its exact selected-product JSON
path, including any escaped hydration format. Confirm it describes the rendered title/product,
not a request parameter or recommendation. Verify the configured store independently. Check a
matching ASIN, a different rendered ASIN at the requested URL, and an unavailable item. Unsupported
hydration formats intentionally fail closed until their retained originals establish ownership.
Keep saved pages outside git; do not fetch a replacement for historical evidence.

R68 full-catalogue policy: both bounded reads must cover their stable stated counts exactly and
agree on the complete ASIN set, irrespective of order. Equal totals alone are insufficient. Retain
the union for collection even when the catalogue is partial; only explicit catalogue agreement
authorizes missing-listing revisits. Empty-answer retry bounds and all attempt/credit receipts stay
unchanged. Agreement is evidence for these observations, not a promise the catalogue cannot change.

R62 outcome receipts live in `family_formula_outcome`, separately from queue execution completion.
`queue.familyOutcomes` reads them; `queue.reconcileFamilyOutcomes` takes up to 100 metrics operation
IDs (`metricsOperationId` in the workflow outcome) and links any exact ASIN/variant Amazon formulas that have since arrived. It never captures WF
again or retries an Amazon operation. `no-amazon-source` remains explicit until a formula exists;
owners can add the source and request Amazon work through the existing queue API.

Apply migration 040 with intake paused and duplicate running items drained; it preserves old attempts
and coalesces unstarted requests only. Start workers/API manually after the normal Git deployment.

Deployment validation still required: run the opt-in `packages/adapters/integration/queue-coalescing.test.ts` with
`CRAWLER_TEST_POSTGRES=1` on the test host, and `family-product.replay.test.ts` against an isolated
Temporal test server. Neither server test was run in the restricted editing sandbox. The queue test
uses a temporary PostgreSQL cluster, verifies concurrent batches and in-flight followers, then
settlement and an immediate explicit requeue; no seven-day age gate is added to requeue.
