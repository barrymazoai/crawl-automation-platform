# Amazon five-product pilot after independent Worker deployment

The user limited this round to five products. The normal Brand submission API and Temporal product/label workflows run with Amazon US delivery set to New York 10001. This round appends observations and preserves imported data, prior Reviews and evidence.

- Campaign: `amazon-history-5-us-10001-20260913`
- Run: `01a09b2b-3d1f-7a3d-a376-3a49456bc116`
- ASINs: `B00IG0MJKA`, `B0GBX7416D`, `B0013LAQS6`, `B0G963NB8Q`, `B0FRWTLCMP`
- Manifest SHA-256: `3dde521a75aa05b9299a729dee66cde42cb88fb4e7b61ad8ed5f1fc7e138ef37`
- Mini evidence directory: `/Users/barry/apps/crawlv3-history-20260913/amazon-5-us-20260913`

Five immutable single-product requests were appended to the existing private Amazon configuration. The previous 506 link batches remain available for historical identity and recovery verification. The seven Amazon Activity roles and two campaign roles were restarted individually to load the new configuration. Their nine PIDs changed; unrelated main/pilot Worker PIDs and both monitors were verified unchanged. The existing workflow queue name contains `10`, but the new campaign manifest, product count and five request IDs define this round's actual limit. The cancelled ten- and 2,000-product campaigns were not resumed.

## Recovery before intake

The previous CoQ10 task had terminal parent/label workflows but retained two resource permits. Its old text Worker had returned `TEXT.CITATION_INVALID` without the stop attestation added by the already-deployed fix. Narrow operational recovery verified the original typed input, execution history, Review ownership, retained raw response and absence of owned model processes. The original Review was not changed. Immutable R2 proof was published and read back before releasing the exact model permit.

The existing browser recovery helper then verified the completed product and label, released model permit, opened/closed page journals, and three current target-absence checks. It published the browser proof before releasing the exact browser permit.

The first new submission encountered HTTP 409 because the cancelled old Brand root still held its source intake guard. This was expected isolation policy: cancelling a parent does not prove its ABANDON children stopped. `recover-amazon-cancelled-intake.ts` verified the exact five-workflow tree, no reset/retry/new run, both product identities, no provider/browser execution in the product cancelled while waiting, the completed product's page close, current target absence, and both prior recovery proofs. It recorded the real CANCELLED terminal receipt through `PostgresDelivery`, releasing only that request's guard. The production gateway policy was not relaxed. The same new campaign and request were resumed without duplicate intake.

Proof keys:

- `v3/amazon-history-recovery/permit-01a09adf-3a99-708d-83e7-3fdfd8aa2d0a-0/proof.json`
- `v3/amazon-history-recovery/permit-01a09ade-81bf-73df-85af-bf82397d696e-0/proof.json`
- `v3/amazon-history-recovery/f687da2b-db01-4dc9-aafa-0ca30a5200ae/cancelled-intake-proof.json`

Recovery helpers compiled locally and passed `pnpm --filter @crawl-automation/v3-workers check-types`. All actual provider/browser/recovery operations ran on Mini. Credentials remain in private files on Mini.

## Business result

The five-product campaign was resumed at 14:34 UTC. The first product exposed a private configuration mismatch: incoming vision tasks pinned `98795c45b9a516214587a26668b51629772d9636f9cfdbddd1ac2a6149d154de`, while the deployed vision provider reported `623632994ec3090b741c8e67fc1abb9962bcb8d38b04dc371ec4798075bedaba`. The Activity failed in six milliseconds at the explicit configuration guard, before handoff or provider access. The generic Activity wrapper discarded that original exception.

The campaign was paused while the source and label vision fingerprints were aligned in a new private configuration file. The seven Amazon Activity roles were restarted individually; unrelated PIDs and the main monitor remained unchanged. Models, provider settings and extraction protocols were not changed. The failed task's original evidence remains intact. Its exact held vision permit was recovered after verifying the original task, deployed build/guard, unchanged provider configuration, unique successful grant, absent local/remote intent and response/failure objects, and no owned model process. The proof is `v3/amazon-history-recovery/permit-01a09b32-184c-74ed-a5da-6101a5394a66-6/config-proof.json`. The same campaign resumed at cursor 1; the first product was not silently retried.

The B12 product downloaded all six original images. CoQ10 and fish oil failed on their first image acquisition after approximately 5.6 and 4.2 seconds, respectively. Their pages and price observations were retained. `EgoFileTransport` maps fetch/redirect/response-validation exceptions to the same `SOURCE.NETWORK_UNAVAILABLE` result and does not retain the original browser exception. These events do not establish host disconnection, proxy failure, IP blocking, or a 25-second timeout. The exact failure mechanism remains undiagnosed and needs better download error evidence.

The current Amazon configuration uses one Mini Ego browser space and `mini-ego-host/1`; it does not consume the earlier four-exit admission pool or rotate egress per product. New York 10001 is the Amazon delivery setting, not a verified public-IP location.

All five current price observations have been retained. Historical purchase/delivery conditions were not fully recorded; these are page-quote differences, not identical-condition transaction-price comparisons.

| ASIN | Product | Prior USD quote | New USD quote | Difference |
| --- | --- | ---: | ---: | ---: |
| B00IG0MJKA | Nature's Bounty B12, pack of four | 19.57 | 16.99 | -2.58 |
| B0GBX7416D | Nature's Bounty CoQ10, pack of two | 37.34 | 37.22 | -0.12 |
| B0013LAQS6 | Nature's Bounty fish oil | unavailable | 10.45 | not comparable |
| B0G963NB8Q | Horbäach collagen peptides | 9.99 | 9.99 | 0 |
| B0FRWTLCMP | Best Naturals cinnamon/chromium, pack of two | 19.98 | 19.98 | 0 |

The campaign completed at 15:01:31 UTC. Closeout at 15:02:23 UTC verified exactly five submissions/attempts, five captured products, five appended `metrics` trend observations, and zero fully collected products. All five product and label workflows ended in Review. There are 14 module-level Review records across those five products, not 14 separate failed products.

- B12: all six original images retained; text ingredient-heading validation failed and the initial vision configuration mismatch prevented its image interpretation. This observation was preserved without retry.
- CoQ10, fish oil, cinnamon/chromium: original-image acquisition failed; text processing also produced quality Reviews. Their captured pages and prices remain durable. The broad network code does not establish the underlying transport/browser cause.
- Collagen: image interpretation ran with the aligned configuration. A candidate image lacked the required label core, and the final product remained in Review with `TEXT.LABEL_INGREDIENT_HEADING_INVALID`.

All five exact owned page journals matched their Temporal close receipts. Three current read-only inventories confirmed all five targets absent. Both held resource permits and intake guards for the five requests were zero. At 15:03 UTC, the main 90, Mini DTC 26 and pilot 2 independently managed services were all ready with fresh monitor snapshots. The old ten-/2,000-product campaigns remain cancelled. No further product was submitted.

[Sanitized closeout evidence](evidence/2026-09-13-amazon-five/closeout.json) contains the five product outcomes, page IDs and close hashes, three absence checks, trend rows, price comparisons and final service health. This round verifies capture/history persistence and terminal cleanup; it does **not** pass complete product/label collection acceptance.
