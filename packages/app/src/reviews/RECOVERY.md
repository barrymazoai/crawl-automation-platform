# Retained-answer recovery

`reviews.recover` is a manual tRPC mutation. It has no workflow starter or model,
OCR API, browser, or ScraperAPI dependency. Select **product assembly/collection
Review IDs**, not child text or image Reviews.

```json
{ "dryRun": true, "selection": { "reviewIds": ["label-REVIEW_ID"] } }
```

Alternatively select one page with `selection: {filter: {stage:
"product.label.assembly"}, limit: 10}`. Both modes are capped at 25 IDs. There is
no pagination loop or automatic follow-up batch. Omitted `dryRun` means `true`.
The dry run writes only its small audit report to `api_request_receipt`; it does
not publish artifacts, collections, or alter Reviews.

After reviewing the returned items and codes, publish the exact preview:

```json
{ "dryRun": false, "previewId": "UUID_FROM_DRY_RUN" }
```

Previews expire after 30 minutes. Publication re-reads the originals, registered
Review/result receipts, task fingerprints, source identities (including variant),
and artifact bytes. Changed evidence or results refuse publication and require a
new dry run. Each request has a two-minute read/publication deadline. A batch may
have published earlier items before a later item's refusal; `reviews.get` exposes
the durable per-item recovery receipt and repeating the same valid preview returns
already recovered items without publishing again.

Text answers use the current decoder with their original wire protocol and exact
full-text quote scope. Page preparation is recomputed from retained HTML; label
core extraction uses the configured channel policy. Packaging checks run again.
Images require original pixel hashes, registered OCR/keyword evidence, a matching
vision intent, and the retained answer. Registered result/completion hashes are
checked. A reviewed image's decoded response must also match its registered Review
candidate; inconsistent historical candidates remain unavailable.

Complete labels use today's `label-image-first/6` assembly rules and the standard
collected-product schema. Derived answer receipts and the new assembly are written
under `v3/rechecks/`, read back, then a new operation is inserted in
`collected_product` with the recovery receipt in one database transaction. The
assembly links the original Review ID/hash, original join, source receipt hashes,
current rules, and recomputed result. Derived receipts explicitly say
`providerCalled: false`; they never overwrite or impersonate an original
`processing_result` registration. Their registration is the recovery transaction
and collection provenance, not a claim that a model executed again.

The original Review and all original artifacts stay immutable. `reviews.get` and `reviews.list`
adds `recovery.status`, `superseded`, new codes, and the recovered operation/hash.
Unsuccessful rechecks retain Review status and their current codes in this
companion receipt when the preview is applied. Queue rows and provider admission
history are not changed.

No migration or new configuration is required. Existing API database and R2
settings are used; the R2 identity needs create/read access to `v3/rechecks/`.
The existing one-collection-per-observation constraint remains enforced: a
different collection for the same observation is refused, never overwritten.
PDF preparation, missing manifests/answers/receipts, unexecuted sources, and
historical evidence inconsistent with current preparation remain unavailable.
This path never requests replacement evidence. Local-only saved answers must
already have a verified retained copy available to the API before recovery.

Before deployment acceptance, exercise one chosen product through dry run and
publication on the server, then confirm `products.get` and `reviews.get`. No live
publication, paid request, or production batch is part of the unit-test suite.
