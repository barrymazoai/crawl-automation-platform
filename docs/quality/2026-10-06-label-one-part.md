# Label products with formula or ingredients (CRAWLV3-209)

Owner, 2026-10-06: a product has a formula, ingredients or both — "they are not cancel each other, they can have one
of them". When ingredients come from page text, the page HTML is kept as evidence. The label records whether it is
Supplement Facts, Nutrition Facts or Drug Facts.

## What changed (commit `cf102fd`)

- New ordered labels use evidence policy `label-image-first/7`. One complete part (formula or ingredient list) is a
  product; a label with neither part stays in Review. Conflicts between sources, unknown execution and identity
  failures still block. A verified source that ended in a label-quality Review only warns beside a selected part,
  unless its readable answer contradicts that part; its original codes stay in the warnings.
- Records are `collected-product/5`: `formula` may be null; `formulaFound`, `ingredientsFound`; `labelType`
  (`supplement_facts` / `nutrition_facts` / `drug_facts` / `unknown` / `none`), read from the printed heading of the
  formula's own source; `pageEvidence` names the prepared text document and the page HTML fragment (R2 key + SHA-256)
  behind every page-text source that supplied a kept field.
- `/3` and `/4` records and `/6` assembly files are unchanged.
- Migration `051_label_one_part_products.sql` lets `collected_product` hold `/5` rows (null formula, empty ingredient
  list, at least one part found).

## Rollout note

The first deploy of `cf102fd` ran without `--migrate`, so `/5` inserts were refused until 051 was applied. Intake was
paused, and the migration was applied with the next deploy (`--migrate`, database backed up by the deploy tool).
Products that failed collection in between are requeued.

## Owner decisions

- A product saved with one part is not re-extracted later (formula once); `formulaFound` / `ingredientsFound` allow a
  targeted rerun later.
- Whole Foods reuses an ingredients-only Amazon record as it is.
