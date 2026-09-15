# Resource lifecycle cleanup — 2026-09-15

Implementation commit: `95e4f62` on `main`.

OCR empty/protocol output and model output/handoff failures previously reached Review without a recognized stop proof. The verifier accepted a small set of text/vision quality codes. Exceptions bypassed release even after the provider was stopped.

The new Temporal patch `resource-execution-finally-v1` binds a gated Activity to its permit ID, waits for cancellation acknowledgement, and runs cleanup in a non-cancellable scope. Success releases normally. Review, exceptions and cancellation request an exact invocation stop proof before release; original errors and Reviews are preserved. Unknown execution and unavailable proof/ledger still quarantine capacity. Business operations are not retried by cleanup.

Provider proof is independent of business error codes. OCR records a complete synchronous response after request close and before output validation. A destroyed/timed-out socket supplies no proof. Text/vision record owned process closure even if the turn fails. Attestations are published after the Activity body settles; legacy return attestations remain readable. Successful processing does not add a proof-publication round trip.

Scope: shared resource gate; channel OCR/text/vision/resource factories; saved-channel/GNC stream/text Activity binding. Browser ownership/close rules, collection inputs, extraction model, business schemas, price history and passive Review records are unchanged. This does not turn arbitrary Activity timeouts or a dead Worker into proof that a remote provider stopped.

Validation on Mini:

- 140 tests passed, none failed/pending: arbitrary Review codes, output validation errors, provider/process failures, cancellation, unknown execution, lost proof writes, idempotent release, sibling quarantine, and existing channel workflows.
- 26 existing Temporal histories replayed successfully: current Amazon products/labels/root and representative Swanson/GNC/DTC/catalog histories. Replay executed no Activities.
- Type checking and diff whitespace checks passed locally; all provider/integration execution stayed on Mini.
- The first integration run exposed a test assumption about concurrent admission order. The test now waits for the first admission before testing the waiting sibling; the final full suite passed.

Deployment:

- 23 affected Mini Workers independently replaced and restarted: main deployment 16, DTC companion deployment 7.
- New Activity build: `cbbe6c119ab9d4409fff6cf7a6325bae8a284fcdb2fd48647de195f6fac9307e`.
- New Workflow build: `6c4ea633e8d38cbd088415b54bdc059f4ab71ef63b9321695fb325403e1fd72e`.
- Exact process executable, build, PID change and Temporal poller checked for every affected Worker.
- Three post-deploy samples: main 90/90 ready, DTC Mini 26/26 ready. Monitors and unrelated Worker PIDs unchanged. Windows browser Workers and campaign Workers unchanged.
- Mini evidence root: `/Users/barry/apps/crawlv3-history-20260913/resource-finally-20260915`.

The historical OCR.EMPTY invocation predates lifecycle receipts. Its separate one-time audit verifies the exact deployed legacy build, full HTTP-return branch, immutable terminal history, single Activity attempt and preserved Review. It is not an error-code allowlist for new tasks. Recovery never calls OCR, edits a Review, or recreates a product task.

Recovery and live verification:

- At 03:43:55 UTC, released only `permit-01a0a2f2-d4dd-7061-b230-8abfd325926f-8`, after retaining the exact stop proof at `v3/manual-legacy-ocr-stop/permit-01a0a2f2-d4dd-7061-b230-8abfd325926f-8/proof.json`. No provider call or result-registration change occurred; Review hash stayed identical.
- At 03:45:09 UTC, original campaign `amazon-night-350-us-10001-20260914` retained run `01a0a2cd-1413-727c-9ef7-57672d5c7461`, advanced to cursor 14 (the fifteenth chunk), and reported `waiting-for-products`, error null.
- 150 products submitted; the fifteenth chunk's ten product Workflows are RUNNING. One browser permit is actively owned by its current product, and the old OCR permit is released. This is normal serial browser capture with downstream processing, not ten concurrent browser sessions.
- Plane CRAWLV3-72 moved to Review. CRAWLV3-73 (the separate root-query recovery change) remains deferred; its pending code was excluded from this build/deployment.
