# Review diagnostics and a label rule table: plan

> 2026-10-12. Owner asked why fine-grained label Reviews keep coming back. Owner decisions the same day: no
> deploy-time replay of stored answers; keep the diagnostics (Part B) and replace the replay with a label rule table
> (Part C) whose own real examples are the regression tests ("行，那就按照这个顺序来吧").
> Background: the 2026-10-12 analysis of all 1,520 queue Reviews (six channels). Fixes already shipped in `ed591f2`.

## Why Reviews keep coming back

- **Rules written from a few examples, never replayed on real labels.** The percentage rule was written for "90% Whey"
  and tested on made-up fixtures; on real labels it rejected 166 standardization rows ("95% curcuminoids"). Same
  lesson as R62 (Whole Foods parser passed made-up tests, broke every real page).
- **Two halves of the code disagree.** Assembly and collection compared serving sizes differently (57 products); the
  vision prompt and the parent validator disagree on blend totals (~138 products).
- **Reviews lose their real cause.** 352 Reviews say `CHANNEL.LABEL_NO_SOURCE`. All were recorded after the
  2026-10-04 `source-failure-first/1` change, and 103 Swanson ones still contain a real text-model failure. Other
  Reviews keep only a wrapper code (`EVIDENCE_UNRESOLVED`, `PRODUCT_UNVERIFIED`, `PAGE.UNRESOLVED`, HTTP failures
  without status). Each round therefore needs a manual investigation.

## Part B: keep the real cause in every Review

| Gap | Where | Change |
|---|---|---|
| `LABEL_NO_SOURCE` hides a real source failure (Swanson 103) or says nothing (Amazon 192, DTC 24) | `processing/src/label/ordered-progress.ts`, `workflows/src/label/label-workflow.ts` | A real model or source failure always wins over "no label on another source", not only at equal progress. A true "no source" lists each source's outcome: skipped (why), keyword screen missed, unsupported type, not a supplement |
| Collection / assembly / page preparation catch-alls | `assembly/label-collection.ts`, `assembly/assembly-files.ts`, `pages/page-evidence.ts`, `workflows/src/label/label-ordered.ts`, `label/label-plans.ts` | Keep the original error code, name, message and zod issue paths in the Review details |
| Vision Reviews keep codes, not which row failed | `vision/vision-review.ts` | Add the findings (row, text, detail) the contracts already compute |
| Amazon `PRODUCT_UNVERIFIED` (29) | `channels/amazon/src/dom.ts`, `product.ts` | Name the failed condition (missing `#ppd`, title not unique, ASIN unavailable) |
| File download failures without status (Costco 8) | `channels/core/src/files/file-download.ts`, `file-review.ts` | Keep HTTP status, public URL and redirect |
| DTC variant Reviews lose the member reason (40) | `workflows/src/dtc-variants.ts`, `app/src/pipeline/product-reviews.ts` | Keep variant ID, member reason and evidence keys |

All shared code, one place each, every channel at once. Review records are immutable, so this only improves new
Reviews; old ones are explained by the replay in Part A.

## Part C: label rule table

Label validation and equivalence rules move from scattered `if`s into one typed table in `packages/v3-contracts`
(shared by every channel). Each rule has an ID, the date and reason it was added, the channels/fields it applies to,
its check, and **real examples taken from stored labels**: rows it must accept and rows it must reject. One test runs
every rule against every example, so a new or changed rule that breaks an older rule's example fails at once — this
is the regression check, in seconds, without a deploy-time replay. A new case means a new rule with its examples; an
over-broad rule is narrowed in place with the example that exposed it. Label Reviews record the rule ID and the row
that failed. First rules moved: percentage roles, serving-size equivalence, ingredient boundaries, parent/blend
hierarchy. Library: generic rule engines (e.g. json-rules-engine) express rules as JSON and cannot hold the regex and
bracket-depth logic these need; a typed TypeScript table is used instead.

## Order and checks

1. Part B without the label-rule items (no-source cause, catch-alls, Amazon page check, download status, DTC variant
   reason). `pnpm check`, tests, independent review, deploy with the normal pause/deploy/resume/requeue procedure.
2. Part C: the rule table with real examples; vision Reviews then record rule ID and row (Part B's vision item).
3. Later rule fixes (parent/blend-total protocol, ingredient boundaries) are added as rules with examples; those that
   need a new extraction protocol version still need model calls.

Not in this plan: re-running models or touching existing Review records.
