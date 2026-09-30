# R34 + R35 error audit

Implemented in the authorized V3 folders. No commits, branches, dependency installation, package.json changes, baseline changes, server actions, or excluded-file edits were made. Concurrent edits were retained.

## R34: literal → registry

67 previously unregistered codes/reasons are now declared with `defineErrors`; in-scope call sites use the registry’s typed `.code()` helper. `RUNTIME.RECOVERY_FAILED` is an additional diagnostic code for uncoded failures; the original error remains in the pino `err` field. Existing persisted code spellings are unchanged.

| Literal                                             | Registry                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `BRAND_SCAN.UNRESOLVED`                             | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `CHANNEL.DEPENDENCY_UNAVAILABLE`                    | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `CHANNEL.DOM_TEXT_PROJECTION`                       | [`factsErrors`](../../packages/channels/core/src/facts/facts-errors.ts)             |
| `DTC.FACTS_VARIANT_UNASSIGNED`                      | [`dtcEvidenceErrors`](../../packages/channels/dtc/src/evidence-errors.ts)           |
| `FACTS.AMOUNTS_MISSING`                             | [`factsErrors`](../../packages/channels/core/src/facts/facts-errors.ts)             |
| `FACTS.FROM_AMAZON_BY_ASIN`                         | [`factsErrors`](../../packages/channels/core/src/facts/facts-errors.ts)             |
| `FACTS.INGREDIENT_AMOUNTS_MISSING`                  | [`factsErrors`](../../packages/channels/core/src/facts/facts-errors.ts)             |
| `FACTS.OTHER_INGREDIENTS_MISSING`                   | [`factsErrors`](../../packages/channels/core/src/facts/facts-errors.ts)             |
| `FACTS.SERVING_QUANTITY_MISSING`                    | [`factsErrors`](../../packages/channels/core/src/facts/facts-errors.ts)             |
| `FACTS.SERVING_SIZE_MISSING`                        | [`factsErrors`](../../packages/channels/core/src/facts/facts-errors.ts)             |
| `FACTS.TEXT_MISSING`                                | [`factsErrors`](../../packages/channels/core/src/facts/facts-errors.ts)             |
| `FORMULA.FAMILY_UNREADABLE`                         | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `FORMULA.LABEL_IMAGE_UNAVAILABLE`                   | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `FORMULA.LABEL_MISMATCH`                            | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `FORMULA.LABEL_TEXT_UNAVAILABLE`                    | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `FORMULA.NO_SIBLING_FORMULA`                        | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `FORMULA.SIBLING_FORMULA_UNREADABLE`                | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `GNC.BRAND_MISSING`                                 | [`gncPageErrors`](../../packages/channels/gnc/src/gnc-page-errors.ts)               |
| `GNC.FACTS_AMOUNTS_MISSING`                         | [`gncPageErrors`](../../packages/channels/gnc/src/gnc-page-errors.ts)               |
| `GNC.FACTS_DOM_MISSING`                             | [`gncPageErrors`](../../packages/channels/gnc/src/gnc-page-errors.ts)               |
| `GNC.FACTS_OTHER_INGREDIENTS_MISSING`               | [`gncPageErrors`](../../packages/channels/gnc/src/gnc-page-errors.ts)               |
| `GNC.FACTS_SERVING_SIZE_MISSING`                    | [`gncPageErrors`](../../packages/channels/gnc/src/gnc-page-errors.ts)               |
| `GNC.FACTS_TABLE_MISSING`                           | [`gncPageErrors`](../../packages/channels/gnc/src/gnc-page-errors.ts)               |
| `GNC.GALLERY_UNVERIFIED`                            | [`gncPageErrors`](../../packages/channels/gnc/src/gnc-page-errors.ts)               |
| `HISTORY.METRIC_TIME_UNKNOWN`                       | [`historyErrors`](../../packages/app/src/history/history-errors.ts)                 |
| `HISTORY.STORAGE_UNAVAILABLE`                       | [`historyErrors`](../../packages/app/src/history/history-errors.ts)                 |
| `LABEL.ACTIVITY_UNKNOWN`                            | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `LABEL.AMOUNT_UNREADABLE`                           | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.CONTAINER_COUNT_CONFLICT`                    | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.CORE_MISSING`                                | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.COVERAGE_UNCERTAIN`                          | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.EVIDENCE_UNCERTAIN`                          | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.EXTRACTION_INCOMPLETE`                       | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.FORMULA_CONFLICT`                            | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.FORMULA_INCOMPLETE`                          | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.INGREDIENTS_INCOMPLETE`                      | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.INGREDIENT_BOUNDARY`                         | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.INGREDIENT_HEADING_INVALID`                  | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.INGREDIENT_ROLE_INVALID`                     | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.OTHER_INGREDIENTS_CONFLICT`                  | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.ROW_ORDER_INVALID`                           | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL.SOURCE_NOT_COMPLETE`                         | [`labelValidationErrors`](../../packages/processing/src/label/validation-errors.ts) |
| `LABEL_PRODUCT.COMPLETE_TEXT_FALLBACK`              | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `LABEL_PRODUCT.FORMULA_CONFLICT`                    | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED`       | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `LABEL_PRODUCT.INGREDIENTS_CONFLICT`                | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT`     | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT` | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT`             | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `LISTING.IDENTITY_CONFLICT`                         | [`listingErrors`](../../packages/platform/src/errors/listing-errors.ts)             |
| `LISTING.LIVE`                                      | [`listingErrors`](../../packages/platform/src/errors/listing-errors.ts)             |
| `LISTING.NOT_FOUND`                                 | [`listingErrors`](../../packages/platform/src/errors/listing-errors.ts)             |
| `LISTING.REDIRECTED_AWAY`                           | [`listingErrors`](../../packages/platform/src/errors/listing-errors.ts)             |
| `LISTING.REDIRECTED_TO_OTHER_PRODUCT`               | [`listingErrors`](../../packages/platform/src/errors/listing-errors.ts)             |
| `PACKAGING.PACK_MEANING_UNRESOLVED`                 | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT`         | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `PACKAGING.SERVING_SIZE_CONFLICT`                   | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `PIPELINE.ACTIVITY_UNRESOLVED`                      | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `PIPELINE.BROWSER_QUEUE_MISSING`                    | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `PIPELINE.FILE_IDENTITY`                            | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `PIPELINE.FORMULA_PENDING`                          | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `PIPELINE.PRODUCT_UNRESOLVED`                       | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `PIPELINE.RETRY_DENIED`                             | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `SWANSON.VARIANT_ENUMERATION_UNVERIFIED`            | [`swansonErrors`](../../packages/channels/swanson/src/swanson-errors.ts)            |
| `VALIDATION.FORMULA_MISSING`                        | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `VALIDATION.INGREDIENTS_MISSING`                    | [`assemblyErrors`](../../packages/processing/src/assembly/assembly-errors.ts)       |
| `WHOLEFOODS.AMAZON_FORMULA_MISSING`                 | [`pipelineErrors`](../../packages/platform/src/errors/pipeline-errors.ts)           |
| `RUNTIME.RECOVERY_FAILED`                           | [`platformErrors`](../../packages/platform/src/errors/platform-errors.ts)           |

| Already registered audit item                             | Result                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SWANSON.IDENTITY_UNVERIFIED`                             | Already uses `swansonErrors.create`; retained.                                              |
| `RESOURCE.OWNER_QUARANTINED`                              | Already in `resourceGateErrors`; Label permit reasons now use `resourceGateCodes`.          |
| `BRAND_SCAN.URL`                                          | Already in core `brandScanErrors`; source-import fallback now uses `.code()`.               |
| text-recheck `TEXT.UNCLASSIFIED`, `TEXT.CITATION_INVALID` | Already in processing `textErrors`; recheck now uses `.code()` and records original errors. |

`BRAND_SCAN.UNRESOLVED` and `FACTS.FROM_AMAZON_BY_ASIN` have registry entries ready for the excluded call sites. Their owners still need to switch those references in the second pass.

## Automated check

[registry-audit.test.ts](../../packages/platform/src/errors/registry-audit.test.ts) uses the existing TypeScript compiler and Vitest. It discovers `defineErrors(...)` declarations via AST and asks TypeScript for their keys, supporting computed properties and mapped/dynamic CODEX registries. It checks exact uppercase dotted literals, including template literals, across the authorized production sources. Tests demonstrate rejection in throw, create, code, and causeCode positions. Comments and code-prefix transformations are not treated as emitted codes.

Library search: ESLint supports [no-restricted-syntax selectors](https://eslint.org/docs/latest/rules/no-restricted-syntax), and typescript-eslint offers [no-floating-promises](https://typescript-eslint.io/rules/no-floating-promises/). Selectors do not provide the cross-file registry/type resolution needed here; no-floating-promises also accepts catch handlers without verifying their handling. The installed TypeScript type checker resolves existing computed registries without a new parser or dependency.

The test’s `secondPass` filter names the user-protected paths explicitly. Tests, testing helpers, generated code, node_modules and dist are excluded. Remove the protected-path filter as ownership permits completing the second pass.

## R35: catch → fix

| Catch / recovery path                                                                                                        | Fix                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| processing `codex/codex-client`, `codex/codex-errors`                                                                        | Renamed Codex failures preserve the original error as `cause`, including standalone vision renaming. Private-config causes were already retained.                                                                                 |
| processing `step/intent-claim`, `text/step/text-intent`                                                                      | Factory wrappers preserve the exact write/parse error even if a callback ignores its cause parameter; the text callback now forwards it.                                                                                          |
| processing `publication/claim-once`, `pages/page-preparation`                                                                | Claim factories preserve the original create error; page intent mapping now passes it. A failed claim never causes another write.                                                                                                 |
| processing `results/result-record`, `stored-result`, `result-recovery`                                                       | Integrity failures retain JSON/schema/byte-verification causes through `withCause`.                                                                                                                                               |
| processing `text/protocol/anchored-decoder`, `text-protocol`                                                                 | Schema and citation wrappers carry the original parse/quote error.                                                                                                                                                                |
| processing `publication/claimed-publication`, `results/write-once`, `result-store`                                           | Lost create/register responses are logged with their real errors before the existing read-back; no second write or business retry.                                                                                                |
| processing `step/kept-review`, `step-review`, `remote-reviews`                                                               | Record append and read-back rejection reasons, including promise `.then` rejection callbacks.                                                                                                                                     |
| processing `step/processing-step`, `pages/page-preparation` recovery lookups                                                 | Record both the original execution error and failed read-only reconciliation, including a result that finished meanwhile.                                                                                                         |
| processing `assembly/label-assembly`, `label-collection`, `assembly-review`                                                  | Record publication/registration failures before read-back, and retain unclassified original reasons behind Review codes.                                                                                                          |
| processing `vision/vision-attempts`, `vision-results`, `vision/protocol/label-vision-v2`                                     | Record call-failure retention, optional response reads, registry failures and ingredient-boundary diagnostics.                                                                                                                    |
| processing `label/label-core-step`, `label/saved-sources`, `keywords/keyword-screening`, `images/image-ocr-task`             | Record real preparation/evidence errors before returning existing Review or fallback states.                                                                                                                                      |
| app `delivery/delivery-coordinator`                                                                                          | Log failed start with request/run identity, then inspect the same workflow; never start twice.                                                                                                                                    |
| app `delivery/delivery-runner`, `cleanup/cleanup-service`                                                                    | Use the tested `ignoreAbort` handler for timer ABORT_ERR only; unexpected rejections propagate. Operational logs include codes.                                                                                                   |
| app `pipeline/label-reviews`, `pipeline/pipeline-capture`                                                                    | Log failed Review writes before read-back; listing/history failures remain observable even when optional observers are absent.                                                                                                    |
| app `reviews/text-recheck`, `reviews/review-evidence`, `history/registry-listing-identity`, `brands/source-import`           | Record actual decoding, evidence, identity and normalization errors before existing fallback results.                                                                                                                             |
| adapters `temporal/temporal-browser-scans`, `inspect-execution`                                                              | Record cancellation errors, malformed payloads and inspection errors rather than discarding them.                                                                                                                                 |
| adapters `files/fleet-status-files`, `pm2/job-health`                                                                        | Record unreadable status JSON; distinguish optional ENOENT absence from other I/O failures.                                                                                                                                       |
| adapters `temporal-run-executions`, `temporal-workflow-tree`                                                                 | Document and test the SDK WorkflowNotFoundError / gRPC NOT_FOUND mapping; unexpected failures propagate even with identical messages.                                                                                             |
| channels GNC `gnc-commerce`, `gnc-family`                                                                                    | Log the actual JSON-LD parse error while preserving independent meta tags and family option links.                                                                                                                                |
| channels core `planning/plan-reviews`, `product-plans`                                                                       | Record failed Review append and read-only plan reconciliation without repeating publication.                                                                                                                                      |
| platform `fetch/scraperapi-client`, `scraperapi-redirects`, `scraperapi-settings`                                            | Transport wrappers preserve causes. URL.parse avoids catch-based URL validation. Only expected SOURCE.ORIGIN_BLOCKED is deliberately suppressed; unexpected validator errors propagate. Provider/key-bearing URLs are not logged. |
| platform `storage/artifact-publication`, `publication-claim`, `file-copies`, `artifact-resolver`, `r2-objects`               | Wrapped storage failures retain cause; uncertain publication is recorded before read-back. Existing ENOENT/EEXIST semantics stay narrow and are covered by storage tests.                                                         |
| platform `storage/media-signatures`, `storage-logger`                                                                        | Record malformed media checks. Storage recovery logging retains a bounded, redacted reason and a registered code for uncoded errors.                                                                                              |
| platform `codex/codex-preflight`, `rpc-decoder`, `turn-execution`                                                            | Retain preflight/protocol causes. The early done.catch observer is documented and tested: the original promise still rejects with the exact failure for its owner.                                                                |
| platform `codex/error-detail`                                                                                                | Serialization failures pass through the same bounded secret-redaction path, retaining the actual reason without logging raw payloads.                                                                                             |
| platform `health/heartbeat`, `database/database`                                                                             | Record heartbeat write errors. Failed rollback is recorded with the original transaction failure; it does not replace the original error.                                                                                         |
| platform `browser/ego-script`, `ego-runner`, `ego-pages`                                                                     | Retain body, close and readiness failure name/code/message through script output and schema parsing; cleanup failure remains pending with its cause. Verified using fake/VM tests only.                                           |
| workflows `label/label-stream`, `stream-label`                                                                               | Replay-safe logs preserve artifact-identity and failed-seal errors; stream-label still throws the original workflow failure.                                                                                                      |
| workflows `label/label-page`, `label-image-ocr`, `label-text`, `label-run`, `label-finish`, `collection/collection-workflow` | Record actual Activity/source/reconciliation errors with the workflow run ID; retain existing receipt-only recovery and cancellation rules.                                                                                       |
| workflows `label/activity-heartbeat`; worker `activities/activity-guard`, `label-activities`                                 | ApplicationFailure wrappers retain their original timeout/activity/release causes.                                                                                                                                                |
| API `container`; deploy `machine-ports`; platform `storage/path-access`                                                      | Share a tested file-access helper: expected ENOENT remains false; permission/I/O errors are recorded with their exact reason.                                                                                                     |

Focused regression tests cover registry membership, exact claim causes and write counts, Codex renaming and early promise rejection, lost-start reconciliation, browser-scan cancellation, expected abort/missing-file/missing-workflow codes, GNC fallback parsing, workflow logs, rollback failures, safe redirect refusal, and task-owned script cleanup evidence.

## Excluded files: second pass

| Location                                                      | Pending item                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/brand-scans/brand-scan-runner.ts`           | Use `pipelineErrors.code("BRAND_SCAN.UNRESOLVED")`; replace silent delay rejection with expected ABORT_ERR handling.                                                                                                                                       |
| `packages/app/src/queue/queue-dispatcher.ts`                  | Silent delay rejection; reuse `ignoreAbort` or record unexpected timer errors.                                                                                                                                                                             |
| `packages/channels/wholefoods/src/whole-foods-adapter.ts`     | Use core `factsErrors.code("FACTS.FROM_AMAZON_BY_ASIN")`.                                                                                                                                                                                                  |
| `packages/channels/amazon/src/{facts,product,script-data}.ts` | Register `AMAZON.FACTS_LABEL_MISSING`, `AMAZON.FACTS_INCOMPLETE`, `AMAZON.GALLERY_UNVERIFIED`, `AMAZON.SCRIPT_DATA_UNREADABLE`; switch shared FACTS codes through core registry. `script-data` also drops its original JSON parse reason.                  |
| `packages/channels/amazon/src/{images,store-page-browser}.ts` | Bare optional-image parse catch and script `.catch(() => null)` need recorded reasons or narrowly tested expected exceptions.                                                                                                                              |
| `apps/worker/src/browser/browser-scanners.ts`                 | Catch returns false without the original reason.                                                                                                                                                                                                           |
| `apps/worker/src/browser/managed-rounds.ts`                   | Expected cleanup-pending/recovered-close branches should explicitly retain or document their original close reasons in the owner’s pass.                                                                                                                   |
| `packages/app/src/brand-scans/scan-listing.ts`                | `sourceUrlOf` now defers `sourceReader` inside the returned callback; 3 source-import tests expect unavailable-reader errors before reading brands. Current execution instead returns per-entry refused results. Resolve this contract in the owning pass. |

No outstanding catch/literal issue was identified in the other protected migration, queue SQL or API wiring files by this audit; they were not edited.

## Verification

| Check                                                            | Result                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript (`pnpm exec tsc --noEmit -p <package>/tsconfig.json`) | Passed for all 12 touched packages/apps: API, worker, deploy, app, adapters, workflows, processing, platform, channels core/GNC/Swanson/DTC.                                                                                                                                        |
| `pnpm lint`                                                      | Passed ESLint and Prettier.                                                                                                                                                                                                                                                         |
| `pnpm check:dupes` (jscpd)                                       | Passed; 449 files, 0 clones / 0% duplication.                                                                                                                                                                                                                                       |
| Final unit suite                                                 | 206 files passed, 1 failed; 1,730 tests passed, 3 failed, 4 skipped. The remaining failures are the source-import/scan-listing contract above.                                                                                                                                      |
| Registry guard and new regression cases                          | Passed, including a final isolated rerun of the typed missing-execution test after correcting its SDK constructor arguments.                                                                                                                                                        |
| Unfiltered requested suite                                       | Attempted; 7 Temporal replay/integration suites cannot start their ephemeral server (Operation not permitted), and 3 PostgreSQL suites cannot initialize shared memory (Operation not permitted). No live browser or provider was contacted and no server deployment was performed. |

The final unit command was:

```sh
npx vitest run --config vitest.v3.config.ts apps/api apps/worker ops/deploy \
  packages/app packages/adapters packages/workflows packages/processing packages/platform \
  packages/channels/core packages/channels/gnc packages/channels/swanson packages/channels/dtc \
  --exclude '**/*.replay.test.ts' --exclude '**/*.temporal.test.ts' \
  --exclude '**/html-capture-postgres.test.ts' \
  --exclude '**/postgres-queue-store-migration.test.ts' --exclude '**/umzug-runner.test.ts'
```

The integration exclusions above apply only to the follow-up command; no test configuration, test assertion or baseline was weakened to hide those failures. Production end-to-end execution remains unverified in this sandbox.
