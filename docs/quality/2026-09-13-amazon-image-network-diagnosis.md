# Amazon original-image failures: page URL mismatch misclassified as network failure

The three `SOURCE.NETWORK_UNAVAILABLE` image Reviews in the five-product pilot are explained by the Amazon adapter binding file access to the original request URL, although the browser had already reached the same ASIN with `?th=1`. The exact-target selection rejects that URL difference before calling `fetch`. Two exception wrappers then hide the selection error as a network failure.

## Original evidence

Read the completed Temporal histories, match each first `acquireAmazonFile` input to its immutable R2 plan and resource ID, then verify the retained projection's size and SHA-256. All three failed products have the extra query parameter; both successful products do not.

| ASIN | Expected page URL suffix | Captured page URL suffix | Original first image outcome |
| --- | --- | --- | --- |
| B00IG0MJKA | `/dp/B00IG0MJKA` | `/dp/B00IG0MJKA` | durable |
| B0GBX7416D | `/dp/B0GBX7416D` | `/dp/B0GBX7416D?th=1` | network Review |
| B0013LAQS6 | `/dp/B0013LAQS6` | `/dp/B0013LAQS6?th=1` | network Review |
| B0G963NB8Q | `/dp/B0G963NB8Q` | `/dp/B0G963NB8Q` | durable |
| B0FRWTLCMP | `/dp/B0FRWTLCMP` | `/dp/B0FRWTLCMP?th=1` | network Review |

The original URLs and hashes are in [sanitized evidence](evidence/2026-09-13-amazon-image-diagnosis/summary.json). The three old raw CLI errors were not retained, so they cannot be recovered verbatim. The retained source records, deterministic selection guard, and current controlled reproduction establish the failing condition without assuming a timeout, proxy outage, or IP ban.

## Mini reproduction

Used the existing Mini Ego SDK 1 task space, unchanged profile/network and New York 10001 delivery context. A separate diagnostic owner held the existing browser resource through the normal admission implementation. It opened one new journaled task page for CoQ10, selected its gallery through the existing `AmazonEgoReader`, and reproduced the original `?th=1` location. This was a bounded diagnostic, not a new Brand/Temporal business submission or a replay of a passive Review.

The unchanged `EgoFileTransport` was called twice against the same exact target and original image URL:

- Expected page `/dp/B0GBX7416D`: rejected with `SOURCE.BROWSER_UNAVAILABLE` in 129 ms.
- Verified observed page `/dp/B0GBX7416D?th=1`: HTTP 200, 176,130 original JPEG bytes, SHA-256 `a9ed8ab8446cb47a7541a1b427a693c2ce5e71c4d7b9ecdf3c5bdde98cd8b4be`, in 96 ms.

An instrumented browser fetch with the same fetch options independently returned the same bytes/hash, response type `cors`, and no redirect. It retained CDP events privately. Cache can satisfy this request; this result verifies that the same browser can read the original image after correcting the page binding, not that every upstream network route is healthy. No cache clearing, alternate host fetch, proxy switch, redirect-policy relaxation, or image re-encoding was used.

## Error chain and proposed fix

1. `apps/v3-workers/src/amazon-live-worker.ts` passes `captured.sourcePlan.expectedUrl` to `EgoFileTransport`.
2. `packages/v3-acquisition/src/ego-file.ts` requires exact target ID and exact page URL. The changed URL causes `EGO_TARGET_MISMATCH` before the browser fetch expression runs.
3. `packages/v3-acquisition/src/ego-browser.ts` converts the CLI error to `BrowserError(SOURCE.BROWSER_UNAVAILABLE)`.
4. `packages/v3-acquisition/src/file.ts` converts a non-`AcquisitionError` transport exception into `SOURCE.NETWORK_UNAVAILABLE`.

The fix should bind image access to the verified actual URL from the retained product projection, while continuing to verify Amazon origin, ASIN, task session, exact target, and unchanged page identity. Do not simply remove query strings from every URL or accept arbitrary same-domain pages. If required, version the handoff contract so old retained inputs remain inspectable. Preserve a distinct target/session mismatch error through both wrappers; real fetch failures should separately retain bounded original browser error details.

This investigation adds only an isolated diagnostic helper and evidence. Business source/configuration, installed releases, Workers, historical Reviews and R2 product evidence were not modified. Product/label business acceptance remains pending a production fix and a fresh authorized test.

## Cleanup and verification

Diagnostic target `579B56C9F6135EB0E1A231A3819AC8DA` was closed and verified absent in three current inventories at 15:24:48 UTC. Only its exact diagnostic permit was released; no old permit was reset. Local helper build and `pnpm --filter @crawl-automation/v3-workers check-types` passed. All actual browser operations ran on Mini.

Mini private evidence: `/Users/barry/apps/crawlv3-history-20260913/amazon-image-network-diagnostic-20260913`. The isolated executable lives outside business releases at `/Users/barry/apps/crawlv3-history-20260913/amazon-image-network-tools`.
