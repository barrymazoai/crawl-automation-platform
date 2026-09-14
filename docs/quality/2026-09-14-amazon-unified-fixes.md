# Amazon purchase conditions, labels and throughput

Plane: CRAWLV3-60 through CRAWLV3-67. This change fixes the findings from the ten-product purchase-conditions retest. It keeps the normal Temporal Brand/catalog/product flow and immutable observations.

## Changes

- Convert complete review-count fields such as `(4,247)` into integer observations. Recognize explicit stock and unavailable messages without treating unknown stock as delisting.
- Preserve an existing capture receipt and its originally derived metrics during replay. Improved parsing applies to a new observation; changed underlying capture data still raises a conflict.
- Recognize the observed plain Amazon one-time offer only when the selected price and both native same-form purchase actions agree. Read public DOM attributes without clicking purchase actions or reading hidden offer fields.
- Capture selected inline-twister options only when visible labels, the selected radio and current ASIN agree. Missing quantity stays null with an explicit warning. This does not enumerate additional ASINs.
- Allow consecutive gallery positions to share a full image only when their selected public thumbnail also matches. Different thumbnails still require the large image to change.
- `label-vision/6` keeps the actual blend dose in its formula row and retains separately printed herbal-equivalent quantities and explanations as footnotes. The existing export already preserves these exclusions.
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

The remaining eight-product retest is tracked in Plane. Final throughput must report the deliberate first-pair acceptance pause separately from processing time. Capacity two is a ceiling; actual model/OCR overlap depends on which evidence is ready.

## Reproduction helpers

`build-purchase-conditions.ts` builds isolated Activity groups and acceptance tests. `verify-amazon-unified.mjs` performs bounded real-browser/provider acceptance. `deploy-amazon-unified.mjs` verifies prerequisite reports and restarts only affected roles. `launch-amazon-unified-retest.mjs` prepares the ten-product inputs and starts Temporal with an initial two-product limit. `inspect-amazon-purchase-retest.mjs <batch-dir>` is read-only. `audit-amazon-unified-retest.mjs <work-dir> 2|10` verifies settled results, export material, retained observations, resource timing and exact page closure.

Private deployment configurations, original evidence, browser DOM and provider logs remain on Mini and are excluded from Git.
