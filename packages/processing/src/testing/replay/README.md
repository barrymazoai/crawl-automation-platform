# Shared label fixes and offline replay

The decoder derives structural coverage from cited fields. A sole facts heading must precede the
extracted panel; serving prefixes must immediately precede their extracted values. Ingredient
connectors must sit between two balanced, anchored items. Whole recognized DV footnotes can fill
otherwise uncovered gaps. Nutrient names, ingredients, strengths, units and unrecognized text still
need citations. Drug Facts retains its explicit heading, active strengths, Purpose and cited sections.

The shared ingredient scanner handles nested round and square brackets, conjunctions and sentence
separators between quoted entries. Initial raw/wild/organic modifiers may contain commas. It does
not split names automatically. Overlap, skipped words, unmatched brackets, multiple declarations
and the split `Natural` / `Artificial Flavors` remain invalid.

Exclusions accept complete recognized label-note sentences tagged footnote, metadata or noise.
These include enzyme-unit definitions, triglyceride reporting, caffeine totals, FDA disclaimers,
DV variants and timing/origin notes. Exact quoted text remains in candidate provenance. Marketing
exclusions still fail; recognized prefixes cannot conceal an extra dose, ingredient or claim.

## Selecting the new assembly behavior

Set the existing shared label setting `evidencePolicy` to `label-image-first/6` for **new** tasks.
It is carried through `LabelPlanInput` to `LabelProductManifest`. No default or deployment config
has changed. `/6` runs the ordinary full-source workflow, not `/5`'s early image-selection workflow.
Model prompts, extraction schemas and model-policy fingerprints are unchanged. Only the assembly
policy enum admits a new value. Recorded `/1`–`/5` assembly behavior stays intact.

With `/6`, a verified complete image or text label can excuse an incomplete sibling image. The
original image answer must be available and schema-valid, its Review must prove execution and
match the exact task/product/variant, and complete sources still pass the existing retained-evidence
reader. Missing registrations, unresolved evidence and identity errors remain blocking.

Every readable partial row and ingredient must agree with the eligible complete sources. Ambiguity,
metadata conflicts, amount/evidence inconsistency, different doses and different ingredients remain
blocking. Registered partial images and image Reviews use the same compatibility check. Warnings
retain the source ID and original failure code; candidates and original Reviews are retained.

`/6` deliberately does not extend historical blanket text-quality/citation waivers. A raw failed
text answer may contain an unverified readable contradiction. Proved absent text labels retain the
existing absent-label warning path. This limits recoveries compared with the report's forecast.

## Running the replay

Supply the external folder containing `review-records.jsonl`, `review-evidence.jsonl` and
`queue-items.jsonl`:

```sh
REVIEWS_0930_DIR=/path/to/reviews-0930 pnpm exec vitest run \
  --config vitest.v3.config.ts packages/processing/src/testing/replay
```

Without the environment variable the replay test is skipped. No saved evidence is committed.
The test verifies document SHA-256 and byte size, re-decodes every saved text raw answer, verifies
source/task identity, and reruns shared assembly decisions over saved candidates plus newly valid
text answers. It reports source-code counts and final-product counts separately. Source codes may
overlap; product counts are deduplicated by run ID and joined to final queue reasons.

These are **counterfactual readiness decisions**, not collection receipts. Saved image registrations
are used as supplied: the export has no original image pixels to verify independently. Newly valid
text answers have no new registrations; the replay calls pure candidate selection without inventing
receipts. Missing source candidates remain unresolved. All current decoder codes are retained,
including secondary blockers hidden by the historical first error. No model, browser, network,
database, Temporal, registration, retry or collection operation runs.

The focused synthetic tests cover positive and negative cases for each fix, Drug Facts, preserved
old policies, conflicting partial/complete labels, missing evidence and foreign variants. Assembly
and cold collection readback are tested with in-memory stores.

## Proposals left unimplemented

- Add explicit quantitative-note data only through a separately versioned schema/instruction change.
  Totals accepted here remain cited exclusions; they do not become ingredient doses or computed totals.
- Model-classified secondary text, supplied-equivalent quantities, undifferentiated enzyme activity
  amounts, patent/form descriptions and other unrecognized notes need a separate semantic review.
- Nested blend restructuring, fuzzy citations, typography agreement, capture/identity repair and
  production reprocessing are outside these four fixes.

## Changed files

All paths below are relative to `packages/`.

- `processing/src/text/protocol/`: `anchored-ingredients.ts`, `coverage.ts`,
  `ingredient-boundaries.ts`, `ingredient-boundaries.test.ts`, `label-coverage.ts`,
  `label-coverage.test.ts`, `label-decoder.ts`, `label-exclusions.ts`, `label-footnotes.ts`,
  `label-headings.ts`, `label-notes.ts`, `label-notes.test.ts`, `label-structure.ts`,
  `quote-occurrences.ts`.
- `processing/src/assembly/`: `assembly-review.ts`, `complete-label-siblings.test.ts`,
  `merge-entry-review.ts`, `merge-policy.ts`, `merge-selection.ts`, `merge-state.ts`,
  `partial-image-selection.ts`, `partial-label.ts`, `source-review.ts`.
- `processing/src/testing/`: `simple-label.ts`; `replay/README.md`, `replay/assembly-decisions.ts`,
  `replay/saved-evidence.ts`, `replay/saved-label-replay.test.ts`, `replay/text-answers.ts`.
- `v3-contracts/src/label-product.ts`: assembly policy enum and corresponding policy validation only.

# Production recovery

Text decoding is shared with `src/recheck/decode-text.ts`. This replay remains a
counterfactual report: publication requires the bounded `reviews.recover` API,
which verifies source bytes, registered receipts and identities before writing.
