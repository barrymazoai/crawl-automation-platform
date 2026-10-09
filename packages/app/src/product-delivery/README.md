# Settled DTC product delivery

## Composition

`SupplySmartProductDelivery` (adapters) implements the frozen `ProductDelivery` port:

```ts
new SupplySmartProductDelivery({ database, rpc, objects });
```

- `database: Queryable`: the existing crawler PostgreSQL connection.
- `rpc: Pick<SupplySmartRpc, "call">`: the existing Supply Smart transport, not another HTTP client.
- `objects: Pick<ObjectStore, "read">`: the existing retained R2 object reader. Required because current
  `product_history_source` records contain commerce and archive references, **not** title/vendor/gallery content.
  No website refetch, OCR, model invocation, or new extraction is performed.

Patterns: **Ports and Adapters**, **Repository**, and an application **Facade**. Mapping, settlement selection,
verification and completion gates live in app; SQL, retained-object reads and RPC calls live in adapters.

## Stored inputs

The reader selects the newest queue entry per `(source_id, listing_id, variant_id)`, always scoped to DTC.
A newer Review/pending attempt cannot fall back to an older success. Completed queue attempts must have a
matching settled receipt. It selects the current run/source's `collected_product` records, checking their existing
schema and hash, then reads the exact capture history and attached enrichment subject. Shared enrichment answers
retain the current product's subject; another product's cached title/projection never supplies its brand.

Terminal `pipeline.product` / `product.enrich` Reviews and unattached enrichment attempts are checked per SKU,
including inside an otherwise completed DTC page. Internal optional-source Reviews are not treated as product Reviews.
`processing_result` candidates are not used as completed labels; `collected_product` is the accepted assembly.

## Mapping

| Crawler field                                                | Supply Smart field                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Request `ingestRunId`                                        | `run.runId`                                                              |
| Request `siteKey`                                            | `run.siteKey`, `run.companyDomain`, item `siteKey` / `domain`            |
| Verified scan start; otherwise earliest submitted capture    | `run.startedAt`                                                          |
| Run ID                                                       | `run.source = crawl-automation:<ingestRunId>`                            |
| Own website `variantId`, else `listingId`                    | `externalId`; site/SKU hash supplies the separate `clientRef`            |
| Own product projection `brandRaw`                            | `brandName` (a legacy site-domain placeholder is omitted)                |
| Own projection title, URL, selected variant URL              | `titleRaw`, `productUrl`, `sourceUrl`                                    |
| Enrichment `unifiedName`, else original title                | `productName`                                                            |
| Enrichment `baseName`, known `form`                          | `baseName`, `productForm`, `variant.form`                                |
| Enrichment flavor, strength, size; unit count if no size     | `variant.flavor`, `strength`, `size` (count is **not** pack or servings) |
| Enrichment confidence in 0–1                                 | `variantConfidence` in 0–100, `variantSource = ai_extract`               |
| Printed health functions, grounded functional ingredients    | `healthFunctions`, `mainIngredients`                                     |
| Capture history timestamp and non-null normalized metrics    | `capturedAt`, price/currency/stock/rating/reviews/rank/sales fields      |
| Own/shared product gallery URLs, excluding other variants    | `images[]` with stable gallery handles                                   |
| Website options / variants, retained commerce extras         | `attrsRaw`, `extras`                                                     |
| Collected formula, other ingredients, citations and warnings | `ingestLabelObservation.label.content` without flattening                |
| Assembly key/hash/size, packaging and source operation IDs   | `label.evidence`                                                         |
| Collected observation identity                               | Label external observation identity; original capture time               |
| Collected operation ID                                       | Stable hashed label ledger key, namespace `crawler-v3`                   |

The original full gallery remains retained. Batch ingest receives all applicable images; the label endpoint
receives at most its 50-image limit. Label calls omit `runId` even for full scans: that endpoint rejects full-run
attachments and explicitly supports independent partial observations. Label operation identity and source do not
depend on the brand-enrichment delivery run, so re-delivery does not invent a new label observation.

## Success and scope

Batches contain at most 200 items. A successful item needs batch acceptance, a successful/replayed full-label
ingest, matching label readback, and observation verification. Verification requires the requested run and exact
client-reference set, `verified == expected`, no batch/item problems and no mismatches. Refused items retain the
server's code/message and do not stop accepted siblings. Transport/protocol failures are not mislabeled as
server item refusals; they remain explicit call failures, with no automatic retries.

Only proven **single-brand site** scans can be full: complete/unlimited scan, no unresolved families, no recent
admission skips, no pending/Review/refused products, matching scan batches/counts, all enumerated variants mapped,
and captures no older than scan start. Shared-site brand subsets and unknown site policy stay partial because
completion is domain-scoped and could otherwise deactivate another sub-brand. Only full, fully verified runs call
`completeCrawlRun`. Empty input sends no empty batch and performs no absence-based deactivation.

## Deliberate omissions / rollout questions

- No identity resolution, variant key generation, company creation, listing state transitions or direct events.
- No invented GTIN, currency, stock, form, flavor, pack count, serving count, listed date, or label confidence.
- Inferred (not printed) health functions are not submitted as observations.
- Full labels do not use the lossy v1 `facts.rows` endpoint. Drug Facts extensions unsupported by the copied
  Supply Smart label schema are refused rather than silently removed. Ingredients-only v5 labels remain valid.
- Old schemas without a current collected label, metric-only/formula-link outcomes without an exact owned label,
  and missing/corrupt retained material stay explicit refusals. No sibling label is copied to manufacture success.
- Frozen requests identify source IDs, not scan IDs. The reader uses the latest scan/queue state at invocation.
  Orchestration must call after settlement and keep those sources stable during delivery/replay.
- The main session still needs to run the opt-in PostgreSQL test and verify actual Supply Smart readback/default
  behavior on a real settled DTC SKU. No server, browser, production database or Supply Smart write is exercised here.

## File inventory

In `packages/app/src/product-delivery/`: `delivery-service.ts`, `errors.ts`, `index.ts`,
`label-delivery.ts`, `label-mapping.ts`, `mapping.ts`, `ports.ts`, `run-mapping.ts`, `selection.ts`,
`semantic-mapping.ts`, `settlement.ts`, `verification.ts`, `wire.ts`, and this `README.md`.

In `packages/adapters/src/product-delivery/`: `delivery-enrichment.ts`, `delivery-materials.ts`,
`delivery-queries.ts`, `index.ts`, `postgres-delivery-reader.ts`, `product-observation-writer.ts`,
`retained-projection.ts`, `supply-smart-product-delivery.ts`; tests `delivery-service.test.ts`,
`mapping.test.ts`, `postgres-delivery-reader.test.ts`, `postgres-delivery-reader.integration.test.ts`,
`retained-projection.test.ts`, `settlement.test.ts`; fixtures `enrichment.fixture.ts`,
`product.fixture.ts`, `rpc.fixture.ts`, `verification.fixture.ts`.

Also changed: `packages/v3-contracts/src/product-delivery.ts` (loose response schemas) and the single
`product-delivery/index.js` export in `packages/app/src/index.ts`.
