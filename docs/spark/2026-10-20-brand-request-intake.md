# Brand request intake: start within seconds (KAN-220)

> 2026-10-20. Owner: "go and implement the long poll". Jira KAN-220, Supply Smart Plane SUPPLYSMAR-455.
> Supersedes decision 3 of the [build plan](2026-10-09-brand-enrichment-build-plan.md) (manual trigger) for
> customer brand requests. Supply Smart side: `brandEnrichment/serviceWaitPending` (jakarta `dev` `a55a75ac`).

## Why

Until now nothing picked Supply Smart brand requests up on its own: `claimPending` / `start` ran only by hand, so
requests waited until someone noticed (GNC from 2026-10-15, Robert's bloodsugarfriendly.com from 2026-10-20). A run,
once started, takes 5–35 minutes (most of it the DTC product capture).

## How it works

Hosted by the `brand-enrichment` worker role, same lifetime as its Temporal workers (`apps/worker/src/brand-request-intake.ts`,
logic in `packages/app/src/brand-enrichment/request-intake.ts`).

| Piece | What it does |
|---|---|
| Long poll | `serviceWaitPending({ limit: free slots, waitMs: 25000 })` on the biz API, back to back. Supply Smart answers at once when requests are pending (woken by the submission itself), otherwise after 25 s with none |
| Claim | `brandEnrichment.claimPending({ limit: free slots })` on the operators' API (`requestIntake.apiUrl`, else `stopSweep.apiUrl`), the same path a person uses: Supply Smart `in_progress` (409 = someone else took it), run row, Temporal workflow |
| Concurrency | `maxLiveRuns` (owner: **1**): live `request` runs are counted before each wait and again before each claim; the long poll and the fallback round take turns, so they never fill one slot twice. While full, it looks again every `busySeconds` (15 s) |
| Fallback | Every `fallbackMinutes` (15) a round claims without the long poll (lost wake-ups, Supply Smart without the procedure yet, a long poll that keeps failing) |
| Timeout | In the same round, a request run still live `timeoutMinutes` (120) after its claim: the request fails with reason `Timeout: …`, the run is marked `timed_out` and cancelled through `brandEnrichment.cancel`, and a red card goes to 「Supply Smart 服务通知」. Once only: a later round only retries the cancel. A timed-out run no longer holds a slot |
| Retailers | Owner 2026-10-20: a request whose URL is a retailer / marketplace site (`RETAIL_SITES` in `v3-contracts`: gnc.com, amazon.com, iherb.com, …, the same list that is never a brand's official website) is not enriched. It fails at once with the reason, no run; `start` throws `BRAND_ENRICHMENT.RETAIL_SITE` |
| Errors | A failing long poll backs off 5 s → 10 s → … → 60 s and resets after a good round; a round whose pending requests all failed to start waits 60 s |

Timeline of a request, from Supply Smart's `brand_enrichment_request` row: `createdAt` (submitted) →
`updatedAt` when it moves to `in_progress` (claimed; should be seconds) → `completedAt` (run closed).

Note on the timeout: `limits.productMaxPolls` (2880 × 30 s) lets a run wait up to 24 h for its products; with the
2-hour timeout such a run is now stopped and failed instead. Raise `timeoutMinutes` if slow sites should finish.

## Settings (`brandEnrichment.requestIntake` in the worker's private config)

| Key | Default | |
|---|---|---|
| `enabled` | `true` | `false` returns to manual intake |
| `apiUrl` | `stopSweep.apiUrl` | operators' API root (tRPC), e.g. `http://127.0.0.1:4188/trpc` |
| `maxLiveRuns` | 1 | request runs alive at once |
| `waitSeconds` | 25 | Supply Smart refuses more than 25 |
| `busySeconds` | 15 | re-check while every slot is taken |
| `fallbackMinutes` | 15 | fallback round, also the timeout check |
| `timeoutMinutes` | 120 | |
| `webhookFile` | none | private file with the Feishu webhook (Server 一: `~/apps/regulatory-private/feishu.webhook`); without it no card is sent. Sent through `tools/notify/feishu.mjs` |

## Scope

Supply Smart **test** only (`test.supplysmart.net`), like the product sync. Production later: needs the production
service key and URL in a second private config, and its own decision on concurrency.

## Verification

- Unit tests: `request-intake.test.ts`, `brand-enrichment-service.test.ts` (retail sites), `brand-request-intake.test.ts`
  (loop, defaults), `brand-requests-api.test.ts`, `brand-intake-alerts.test.ts`, `supply-smart-rpc.test.ts`
  (`waitPending`), `retail-sites.test.ts`.
- End to end on test: add a brand on https://test.supplysmart.net/next/companies (Brands enrichment), expect
  `in_progress` within seconds (worker log `brand requests claimed`, `via: long_poll`), then `completed` with the
  company link.
