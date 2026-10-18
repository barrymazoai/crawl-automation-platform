# ClinicalTrials.gov collector

Keeps a local copy of the ClinicalTrials.gov studies that matter to Supply Smart and turns them into
the import run that Supply Smart's `import:clinical-trials` reads (KAN-217; KAN-213/214 use the same
trials). It is separate from the crawler's channel and product pipeline: no Temporal, no queue, no
crawler database. It writes no database; Supply Smart is only read through its API (service key).
Plan: `docs/plans/clinicaltrials-gov-plan.md`.

## Run

```sh
cd tools/clinical-trials
pnpm install --frozen-lockfile --ignore-workspace     # own lockfile; not part of the workspace
ENV=--env-file=<file with SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY>

node $ENV src/run.mjs collect --data-dir ~/clinical-trials-data --mode backfill      # first run; monthly reconcile
node $ENV src/run.mjs collect --data-dir ~/clinical-trials-data --mode incremental   # daily
node $ENV src/run.mjs deliver --data-dir ~/clinical-trials-data                      # after a collect
node $ENV src/run.mjs collect --data-dir … --mode targeted --companies "Semaine|<company id>" --ingredients "Lavitol"
```

`--max-pages N` stops each search after N pages (trial runs only; the run is then not complete and does
not move the watermark). `--refresh-aliases` reads every branded ingredient's aliases again.

## Collect

| Mode | Reads | Pages |
|---|---|---|
| `backfill` | every registered study (`/api/v2/studies`, 1000 a page, `protocolSection` + `hasResults`) | ≈610, ≈10 MB each, ≈6.4 GB in all |
| `incremental` | studies with `LastUpdatePostDate` ≥ previous data date − 3 days, plus sponsor searches (`query.spons`) for companies and intervention searches (`query.intr`) for branded ingredients that are new in Supply Smart since the previous run | a few |
| `targeted` | only those searches, for the given companies / ingredients (name or id, `|`-separated) | a few |

A study is **kept** when an intervention is `DIETARY_SUPPLEMENT`, its lead sponsor or a collaborator
matches a Supply Smart company, or a branded ingredient name/alias is named in it (the same matchers as
delivery, see below). Everything else is read and dropped; the archived pages still hold it.

Requests: one every 1.5 s (`CTGOV_INTERVAL_MS`), 120 s timeout, 3 retries for network errors, 429 and
5xx; other 4xx answers stop the run. Every page is archived gzip-compressed with its sha256 and read
back before it is parsed.

Supply Smart: `company.allNamesAndId`, `brandedIngredient.list` and, once per ingredient,
`brandedIngredient.getDetail` (aliases; cached in `entities/aliases-cache.json`). At delivery,
`product.listAdvanced` for the brands that have trials. 120 calls a minute (`SUPPLY_SMART_REQUESTS_PER_MINUTE`).

## Deliver

Writes `deliveries/<run-id>/` in the importer's contract (`src/deliver/contract.mjs`, a copy of
supply-smart-mono `packages/product-db/src/clinical-trial-import.ts` at 3c6205c4). Every line is checked
against it before it is written.

| File | Rows |
|---|---|
| `manifest.json` | `run_id`, `fetched_at` (last collect), `source_db` (`cloud-test` for test.supplysmart.net, else `SUPPLY_SMART_SOURCE_DB`), counts |
| `trials.jsonl` | every linked trial (registry values as given, `raw` = the API record) **and** every trial linked last time, so the importer drops links the matcher no longer makes |
| `trial_company_links.jsonl` | brand ↔ trial from the lead sponsor / collaborator fields only |
| `trial_product_links.jsonl` | product ↔ trial, searched only inside a brand linked high or medium |
| `trial_ingredient_links.jsonl` | branded ingredient ↔ trial (KAN-214 draft contract; no importer yet) |
| `review/unmatched_industry_sponsors.jsonl` | industry sponsors of supplement trials that Supply Smart doesn't have, with counts: candidates for new companies or for `aliases.json` |
| `review/ambiguous_sponsors.jsonl`, `review/rejected_ingredient_terms.jsonl` | what was held back, for review |

Then on the Supply Smart side (their rule: print the target and get the owner's go-ahead before `--apply`):

```sh
pnpm -F @supply-smart/product-db import:clinical-trials -- --run=<deliveries/run-id>            # dry run
pnpm -F @supply-smart/product-db import:clinical-trials -- --run=<deliveries/run-id> --apply
```

## Matching

All literal; names are normalized (case, accents, ®/™, punctuation) and compared whole.

- **Brand** (`src/match/companies.mjs`), sponsor / collaborator names only:
  `sponsor_exact` = equal without legal forms (Inc, LLC, GmbH…); `sponsor_alias` = the name a "dba" or
  parenthesis states, or equal once business words (Health, Nutrition, USA, International…) are dropped;
  `manual` = `<data-dir>/aliases.json`. A short or ordinary core ("Seed", "Ritual") lowers the confidence;
  several companies tied on the best match are all `low`. Supply Smart hides unreviewed `low` links.
- **Product** (`src/match/products.mjs`): intervention name / other names against the linked brand's
  product names, as word sets without the brand's words, sizes, counts and filler; form words stay
  (`PMS Capsule` ≠ `PMS Gummy`). Same words → high; one contains the other → medium; close → low; only
  the title → low. A trial naming no product keeps just its brand link.
- **Branded ingredient** (`src/match/ingredients.mjs`): name or alias in intervention / arm fields (high)
  or only titles / keywords (medium). Short names, strain codes (`La-14`, `KSM-66`) and ordinary words
  need the supplier's name or a generic-name word in the record (medium), else they are rejected.
  Generic and active-compound matches (taxifolin for Lavitol) wait for Supply Smart's `active_compounds`.

`<data-dir>/aliases.json` (not in git): `[{ "sponsor": "Natals, Inc.", "company_id": "<id>", "note": "…" }]`;
`"company_id": null` blocks a sponsor name that keeps matching the wrong company.

## Data directory

`studies/<NCT0123>/<nct>.json.gz` (latest record of each kept study), `index.jsonl` (why kept, hashes,
first/last seen, `removed_at` when a backfill no longer finds it), `state.json` (watermark, known
entity ids, last delivered trials), `entities/`, `runs/<run-id>/` (log, manifest, archived pages),
`deliveries/<run-id>/`. A backfill archives ≈1.7 GB of pages; old `runs/*/pages` can be deleted
once a later backfill has completed. One run at a time (`.run.lock`).
