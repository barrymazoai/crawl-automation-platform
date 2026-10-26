# product-enrichment/4: form names, health function categories, inferred functions (owner 2026-10-26)

## Problems found in the Supply Smart test database (2026-10-26)

- About 10,000 V3 products had no form. The model answered `other` for caplets and `unknown` for soft chews,
  drink mixes and shots, and the grounding check accepted only the literal enum word (`tablet`, not `caplets`).
- Health functions were the printed claims copied word for word ("support optimal protein synthesis and
  recovery"). Supply Smart had 46,794 health function names; 46,038 were created after V3 started, 33,399 used once.
- Health functions inferred from the main ingredients were computed but never sent (about 5,000 products).
- About 710 sent products had no enrichment and 1,016 only the older /2 one (no main ingredients, so no
  `product_ingredient` rows in Supply Smart).

Whole Foods delivery already uses its Amazon ASIN's enrichment (the Whole Foods subject, without a title, is not
read); the Whole Foods gap is Amazon collections that were never enriched.

## Changes

- Protocol `product-enrichment/4`. /2 and /3 records stay readable. Answers are reused by input hash, so a prompt
  change needs the new protocol for new answers.
- Prompt: common form names map to a form (caplets/tabs → tablet; caps/vcaps/vegcaps/liqui-caps → capsule;
  sgels/soft gels → softgel; chews/soft chews/chewies → chewable; jelly beans → gummy; drink mix/scoops/stick
  packs → powder; shots/beverages/shakes/tinctures/syrups → liquid). Grounding accepts the same names as whole
  words or phrases (`form.ts`).
- Health functions: the model answers `{name, printed}`. `printed` must be printed word for word; `name` is a short
  category (at most 4 words, not starting with a claim verb such as "supports"), merged case-insensitively. Only
  names are sent; the printed words stay on the record as `healthFunctionEvidence`. New names are allowed.
- Inferred health functions follow the same name rule and are sent when none is printed.
- `enrichment.outdated` lists sent products whose enrichment is missing or from an older protocol (none first,
  then /2, then the rest; Whole Foods as its Amazon ASIN); `enrichment.run` takes `selection: "outdated"`.
  Workflow IDs now include the protocol so a product enriched before can be enriched again.
- `productSync.reopen { enriched: true }` re-pends verified products whose current-protocol enrichment is newer
  than their send.

## Running it (bounded, manual)

1. `enrichment.outdated {limit}` to preview; `enrichment.run {limit, approvedCount, selection: "outdated"}` in
   pages of at most 100. Model, effort and concurrency are the owner's choice before a large run.
2. `productSync.reopen {enriched: true, limit}`; the existing sweep sends them again.

Read-only count on 2026-10-26 (crawler database): never enriched 710 (Amazon 452, GNC 236, Swanson 22), /2 1,016,
/3 46,774. Supply Smart keeps its existing 46k health function names; cleaning them is Supply Smart's data.

3. `productSync.updateEnrichment {limit ≤ 100, after?, dryRun}` (dry run by default, `next` cursor) calls Supply
   Smart's `product.updateEnrichmentBatch` (SUPPLYSMAR-464, owner 2026-10-26: a new endpoint rather than changing
   ingest; a resent ingest with a new body is an `idempotency_conflict`). Per product: add the current enrichment's
   form, health functions and main ingredients; remove the names earlier enrichments of the same listings sent and
   no current one sends. Supply Smart deletes links only. Products already up to date are skipped. This replaces
   `productSync.reopen {enriched: true}` for re-enriched products.
4. Health function names left without any product are Supply Smart's to delete: `deleteHealthFunction` cascades to
   every product's link in their database (`product_health_function` FK `ON DELETE CASCADE`, checked read-only
   2026-10-26), so the crawler never calls it.

## Found while validating (2026-10-26)

- `enrichment.outdated` timed out (7 s): per-row lookup into large records. Now set-based and reads the `protocol`
  column (480ec64).
- Every backfill failed with a statement timeout: without a capture operation the title lookup scanned all of
  `product_history_source` (1.3 GB, 4.7 s). This is also why the never-enriched products stayed that way. Backfills
  now reuse the page material (title, description, website variant) of the collection's latest enrichment, and the
  history lookup has an index (migration 068, 983932d). Products never enriched have no stored description and use
  the title and label only.
- The migration's backup failed: the dump passed 2 GiB (2,149,509,407 bytes), more than `readFile` returns; the
  digest is now streamed (503af15). A deploy-tool fix only applies when the deploy runs from a release that has it.
- A re-run could not start a workflow that had already ended (REJECT_DUPLICATE); manual re-runs now may (1ce0195).
- 30 products validated (10 never enriched, 10 /2, 10 /3): sentences became categories ("support healthy liver
  function" → "Liver Support"), missing forms filled (unknown → softgel/liquid/powder).
