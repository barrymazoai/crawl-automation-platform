# Branded-ingredient refresh

Keeps Supply Smart's branded-ingredient data (KAN-208) current after the one-off supplier-intel run of
2026-10-13…16. Runs on Server 一 from crontab, Tuesday and Friday 19:00 US Central, one hour after the
regulatory sync (owner 2026-10-26). Plan: `docs/spark/2026-10-26-branded-ingredient-refresh-plan.md`; this
first phase: `docs/spark/2026-10-26-ingredient-intel-p1-plan.md`.

**Without `--push` it writes files only.** With `--push` (P4) the trial delivery and the links go to Supply
Smart's ingest procedures (SUPPLYSMAR-463). Supply Smart is read and written through its API with the service
key product sync uses; no database connection.

## One job, four steps (`src/sync.mjs`)

1. **Trials**: the ClinicalTrials.gov collector (`tools/clinical-trials`), unchanged and in its own process: an
   incremental collect, then a delivery. The owner wants trials refreshed together with the branded ingredients.
   Its first run is a backfill (≈610 pages, ≈6.4 GB archived) started by hand; until then this step reports that
   it was skipped.
2. **Names**: every Supply Smart ingredient name (`ingredient.listAll`, ≈213k, one call) is matched against the
   branded ingredients' aliases again, about a second. Only the difference from the last reported links goes to
   `runs/<id>/changes/alias_links.jsonl`. The rules are those of supplier-intel `scripts/ss_ingredient_match.py`,
   ported unchanged (`src/rules.mjs`) except that invisible characters (zero-width spaces, soft hyphens) are
   ignored; `src/rules-check.mjs` replays them on the 10-16 files and reproduces Supply Smart's 14,600 links
   exactly. Links are saved only when the run succeeds, and a Supply Smart answer with under 90% of the last
   run's names or branded ingredients stops the run.
3. **Judge**: the ®/™ spellings of names not seen before, cheapest source first: an existing alias, then a
   judgement already made (the 10-15 run's 4,731, rejected ones included, and every later one), and only then
   the model, 50 spellings per call. A supplier ingredient the model ties to a registered one with high
   confidence becomes an alias when it has at least 5 letters and digits, or 4 with a digit (shorter ones such as "mag" go to review:
   they linked unrelated names in the first run); step 2 then runs again for it; an unregistered one is a candidate in
   `changes/ingredient_candidates.jsonl`; anything less certain goes to `review.jsonl`. A reviewed alias is
   added by hand with `src/add-alias.mjs` (below) and is never turned off by the length rule.
4. **Push** (`--push`, `src/push.mjs`), each part only when its own step succeeded in this run:
   - trials: the delivery, 100 trials per batch with every link of those trials (`clinicalTrial.ingest`);
   - links: `brandedIngredient.syncState` is compared with `state/map.json`; the missing links are added and the
     ones the rules no longer make are taken back (`brandedIngredient.ingest`, 500 per batch). Links a person
     made, and links of branded ingredients the crawler doesn't match, are never taken back. More than 2% of
     Supply Smart's links to take back (and more than 20) stops the push with a red card.
   Every batch goes as a dry run first; the real batches go only when all pass with the expected counts, and
   the links are read back afterwards.

The model and effort have no defaults (owner rule: never the machine's Codex default). The crontab line passes
them, `gpt-5.6-luna` / `medium` (owner 2026-10-26: simple judgements on Luna, Server 一's current version).
A failed step is reported and does not stop the others.

## Data (`--data-dir`, e.g. `~/ingredient-intel-data`)

| Path | What |
|---|---|
| `state/registry.json` | the branded ingredients and their match aliases; aliases the job adds carry `aliases_added`, reviewed ones `aliases_manual` |
| `state/verdicts.jsonl` | one judgement per spelling (key: lower case, letters and digits only), with who decided and when |
| `state/map.json` | ingredient id → external keys, as last reported |
| `state/seen-names.json.gz` | ingredient ids whose spellings are settled; a name with a spelling still waiting is retried next run |
| `runs/<id>/` | `run.log`, `report.json`, `changes/`, `review.jsonl`, `aliases_added.jsonl` |
| `last-sync.json`, `last-full-sync.json` | the last run, and the last full scheduled one (for the overdue check) |

## Setup on Server 一

```sh
cd <clone>/tools/regulatory && pnpm install --frozen-lockfile --ignore-workspace     # codexJson and the store come from here
cd <clone>/tools/clinical-trials && pnpm install --frozen-lockfile --ignore-workspace
cd <clone>/tools/ingredient-intel && pnpm install --frozen-lockfile --ignore-workspace

# Once: the state of the supplier-intel run, copied from the MacBook (scp the small files only:
# input/*.csv, out/ingredients_all/candidates.csv, out/uspto_new/per_ingredient_ss.csv,
# out/candidates_*/classified.jsonl, export/supply_smart/out/label/ss_ingredient_brand_map.csv, raw/ids/ss_ingredient.tsv)
node src/import-supplier-intel.mjs --data-dir ~/ingredient-intel-data --supplier-intel <copied folder>
node src/rules-check.mjs --data-dir ~/ingredient-intel-data \
  --names <copied folder>/raw/ids/ss_ingredient.tsv \
  --expect <copied folder>/export/supply_smart/out/label/ss_ingredient_brand_map.csv      # must report 0 differences
```

## Run

```sh
node src/sync.mjs --data-dir ~/ingredient-intel-data \
  --supply-smart-env ~/apps/crawler-v3/manual-releases/brand-enrichment/.env.brand-enrichment \
  --trials-data-dir ~/clinical-trials-data \
  --luna-model gpt-5.6-luna --luna-effort medium \
  --webhook-file ~/apps/regulatory-private/feishu.webhook
# --skip-trials, --no-model, --max-model-batches N (default 40; the rest waits for the next run), --push, --push-dry-run (the dry runs only, nothing written)

node src/check-sync.mjs --data-dir ~/ingredient-intel-data --webhook-file ~/apps/regulatory-private/feishu.webhook

# A reviewed alias (kept in aliases_manual with the reason; the next sync links its names)
node src/add-alias.mjs --data-dir ~/ingredient-intel-data --id ING174 --alias "Nu–Mag" --reason "<what was checked>"
```

The proposed crontab (installed only after the owner approves the first full run):

```
0 19 * * 2,5 cd $HOME/apps/<clone>/tools/ingredient-intel && PATH=$HOME/.local/bin:/usr/bin:/bin node src/sync.mjs --data-dir $HOME/ingredient-intel-data --supply-smart-env … --trials-data-dir $HOME/clinical-trials-data --luna-model gpt-5.6-luna --luna-effort medium --webhook-file $HOME/apps/regulatory-private/feishu.webhook >> $HOME/ingredient-intel-data/logs/cron.log 2>&1
0 12 * * * cd $HOME/apps/<clone>/tools/ingredient-intel && PATH=$HOME/.local/bin:/usr/bin:/bin node src/check-sync.mjs --data-dir $HOME/ingredient-intel-data --webhook-file $HOME/apps/regulatory-private/feishu.webhook >> $HOME/ingredient-intel-data/logs/check.log 2>&1
```

## Measured (MacBook, 2026-10-26, against test.supplysmart.net)

- Rules replay on the 10-16 export: 164,954 names → 14,600 links, identical to Supply Smart's; 1 s.
- Names step: 213,468 names, 48,722 new since 10-16; links 14,600 → 19,375 (4,775 added, none removed); 9 s.
- Judge: 2,488 new spellings: 833 existing aliases, 470 earlier judgements, 1,185 for the model (24 calls).
  One Luna call (50 spellings): 45.6k tokens, about 3 minutes; 2 aliases added (Cran d'Or, ERr 731).
