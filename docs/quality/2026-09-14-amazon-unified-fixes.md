# Amazon purchase conditions, labels and throughput

Plane: CRAWLV3-60 through CRAWLV3-67. This change fixes the findings from the ten-product purchase-conditions retest. It keeps the normal Temporal Brand/catalog/product flow and immutable observations.

## Changes

- Convert complete review-count fields such as `(4,247)` into integer observations. Recognize explicit stock and unavailable messages without treating unknown stock as delisting.
- Preserve an existing capture receipt and its originally derived metrics during replay. Improved parsing applies to a new observation; changed underlying capture data still raises a conflict.
- Recognize the observed plain Amazon one-time offer only when the selected price and both native same-form purchase actions agree. Read public DOM attributes without clicking purchase actions or reading hidden offer fields.
- Capture selected inline-twister options only when visible labels, the selected radio and current ASIN agree. Missing quantity stays null with an explicit warning. This does not enumerate additional ASINs.
- Allow consecutive gallery positions to share a full image only when their selected public thumbnail also matches. Different thumbnails still require the large image to change.
- `label-vision/7` keeps the actual blend dose in its formula row and retains separately printed herbal-equivalent quantities and explanations as footnotes. The existing export already preserves these exclusions. It also preserves an exact redundant, data-free `% Daily Value` column as a heading exclusion when percentages already reside on the single dose column's rows. Columns containing values, extra rows, uncertain citations or multiple dose bases are never folded.
- Use the already-supported `label-image-first/5`: one complete verified image is sufficient, and later redundant OCR/model calls and page-text parsing are skipped. Original file retention remains required.
- Run two products per bounded request using existing Temporal child workflows. Browser admission remains one; parsing can overlap the next capture. Model capacity and OCR/vision activity concurrency are two. Workflow executables and the AI model are unchanged.

## Validation

All browser, provider and integration validation ran on Mac mini.

- 204 regression tests passed, including isolated PostgreSQL history replay and immutable-record checks. Type checking and whitespace checks passed.
- Actual duplicate-image product gallery: 10 positions, 9 different original images; stale-image negative regression still rejects.
- Actual plain offers: one-time purchase detected. The new inline controls yielded the selected 75-count three-pack and 120-count two-pack; absent quantity was not invented.
- Two previously failing retained labels passed the real provider with the new prompt. Actual doses and both equivalent-quantity footnotes were preserved.
- Fourteen affected Activity Workers were independently restarted and their actual build IDs, PIDs and Temporal pollers verified. Unrelated Worker PIDs stayed unchanged. The resource monitor was independently restarted to publish model capacity two.
- Fresh retest: only the same ten products, US / New York 10001, five requests of two products each. The original hundred-product campaign remains paused at product 24.
- Initial two products both completed as `collected`, with zero new Review records. Exact task-owned targets were absent in three read-only checks, no permits remained held, both product-service label materials exported, and all nine prior capture records matched their preserved contents. Actual capture/model overlap was observed.

## Final retest and follow-up

The ten-product Temporal batch completed: ten new capture observations, nine complete products and one product in Review. All ten review counts were parsed; stock was true for eight, explicitly unavailable for one, and unknown for one. Eight valid USD quotes were saved and unchanged against the comparison records. Missing offers and quantities remain unknown. Ten metrics materials and nine label materials passed product-service export checks; all 19 source/observation records and their listing associations passed database readback. All ten owned pages were absent in three checks, with no held permits. The nine previous capture records remained byte-equivalent in content.

Elapsed time was 35m23s including 3m09s of deliberate first-pair acceptance pause: 32m14s of processing, versus the preceding batch's 42m21s (about 24% lower). The comparison describes these measured runs, not a promised throughput or a controlled benchmark. The new run also completed more full products. Browser resource peak was one, OCR peak two, and model Activity/resource peak one despite capacity two. Twelve capture/model interval overlaps were observed. Model readiness, not only capacity, determines actual concurrency.

The sole product Review was a new model error: an extra empty `% Daily Value` column after a correctly transcribed dose column. Its retained response passed the strict header normalization with all original dose rows, ingredients and footnotes unchanged. Twenty-three vision tests and 75 related vision/assembly/image-first tests passed on Mini; type checking passed. After the ten-product run finished, only the vision Worker and seven Amazon Workers caching the new fingerprint were individually restarted. Other Worker PIDs and the resource monitor were unchanged.

The one failed member was resubmitted through the normal Brand API with a new request and observation. It completed successfully in 4m01s: 16 formula rows, the actual 3,400 mg dose and the 3,600 mg equivalent retained, one image-model call, zero text-model calls, zero new Reviews, two history records verified and the owned page absent in three checks. This follow-up is separate from the ten-product timing above. Its four prior Review records were preserved. All ten distinct products now have successful results, and all 90 main deployment Workers remained ready. The original hundred-product campaign stays paused at product 24.

## Reproduction helpers

`build-purchase-conditions.ts` builds isolated Activity groups and acceptance tests. `verify-amazon-unified.mjs` performs bounded real-browser/provider acceptance. `deploy-amazon-unified.mjs` verifies prerequisite reports and restarts only affected roles. `launch-amazon-unified-retest.mjs` prepares the ten-product inputs and starts Temporal with an initial two-product limit. `inspect-amazon-purchase-retest.mjs <batch-dir>` is read-only. `audit-amazon-unified-retest.mjs <work-dir> 2|10` verifies settled results, export material, retained observations, resource timing and exact page closure.

`deploy-amazon-label-header.mjs <work-dir>` requires the completed ten-product acceptance, updates only affected roles, then submits the one failed member through the Brand API. `inspect-amazon-label-header-retry.mjs <work-dir>` performs read-only progress and terminal acceptance for that member.

Private deployment configurations, original evidence, browser DOM and provider logs remain on Mini and are excluded from Git.
