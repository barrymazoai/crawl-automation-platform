# U.S. customs trade puller (KAN-282)

Pulls monthly U.S. imports (HTS) and domestic exports (Schedule B) by 10-digit code and partner country from
the Census Bureau International Trade API and pushes them to Supply Smart's `customsTrade.ingest`. Contract:
supply-smart-mono `docs/packages/database-api/domains/customs-trade-ingest.md`. No crawler database, no
Temporal, no browser; it writes nothing but its data directory and the push.

## What it pulls

`codes.json`: 71 import and 43 export codes (48 ingredients; 17 added 2026-11-18 after the match-gap check), each standing for one ingredient (tier A = mostly a
supplement / nutrient ingredient, A2 = one ingredient, dominated by food / feed / industry). Mixed codes
(vegetable extracts, glycosides, colouring matter, food preparations) are not pulled: their ingredient
share cannot be told. Why each code is there, and which ingredients have no export line, is in `_about`.

Every run reads the **last 36 published months** (`--months`), because Census revises past months (the
previous years every June): re-pushing them keeps Supply Smart current without a separate revision job.
The latest published month is probed (an unpublished month answers 204).

| Census | import | export |
|---|---|---|
| endpoint | `intltrade/imports/hs` | `intltrade/exports/hs`, `DF=1` |
| value | `CON_VAL_MO` (customs value) | `ALL_VAL_MO` (FAS value) |
| quantity | `CON_QY1_MO` in `UNIT_QY1` | `QTY_1_MO` in `UNIT_QY1` |

Country groups (codes 0001–0027) and the `-` total are dropped, so are rows with value and quantity both 0
(Census lists every country that traded the code earlier in the year). A month without trade is pushed as
an empty slice.

## Run

```sh
cd tools/customs-trade          # no dependencies: Node ≥ 22.17 built-ins only
node src/run.mjs --env <private env file> --data-dir ~/customs-trade-data            # fetch + dry runs only
node src/run.mjs --env <private env file> --data-dir ~/customs-trade-data --push     # and write
# --months N | --from YYYY-MM --to YYYY-MM, --direction import|export, --only <code,code>, --codes <file>
npm test
```

Env file (never in git, never logged): `CENSUS_API_KEY`, `SUPPLY_SMART_DATABASE_RPC_URL`
(`https://<host>/api/database/rpc`), `SUPPLY_SMART_API_KEY` (a Supply Smart service key).

A run fetches every code first and pushes nothing unless all were read; then sends every batch as a dry
run, and the real batches (with `--push`) only when all dry runs passed. Batches hold whole slices
(≤ 200 slices, ≤ 5000 rows). Census and Supply Smart calls retry network errors, 429 and 5xx with
backoff; a re-sent batch is counted once by Supply Smart. One run at a time (`.run.lock`).

## Data directory

`runs/<run-id>/census/<direction>-<code>.json` (the API rows as read), `runs/<run-id>/slices.jsonl` (what
was pushed), `runs/<run-id>/report.json` (counts, per-code rows), `last-run.json`.
About 1 MB per run; old runs can be deleted.

## Measured (MacBook, 2026-11-17, local product-server on a fresh migrated copy database)

- 74 codes × 36 months (2023-10 … 2026-09): 2,664 slices, 24,269 rows, 106 empty slices, 14 batches.
  Census reads 453 s (≈ 6 s per 36-month query), dry runs 1 s, push 1 s.
- Re-run right after: 24,269 unchanged, 0 inserted / updated / removed.
- Against the USITC DataWeb exports of the KAN-282 pilot (2025-01 … 2026-09, 8 codes in both): 907
  cells, 0 differences in value and quantity.

## On Server 一 (installed 2026-11-17)

```sh
cd $HOME/apps/customs-trade && git pull                            # code only through git (repo rule)
# confidential config, chmod 600, never in git:
#   $HOME/apps/customs-trade-private/.env             test        (SUPPLY_SMART_* from brand-enrichment/.env.supply-smart-test)
#   $HOME/apps/customs-trade-private/.env.production  production  (SUPPLY_SMART_* from brand-enrichment/.env.brand-enrichment)
#   both carry CENSUS_API_KEY
```

crontab (Server 一 runs on US Central), monthly on the 12th: Census publishes a month about 5 to 8 weeks after it
ends, and every run re-reads the last 36 months, so revisions land too. Test first, production half an hour later;
each run writes only when all its dry runs pass.

```
0 10 12 * * cd $HOME/apps/customs-trade/tools/customs-trade && PATH=$HOME/.local/bin:/usr/bin:/bin node src/run.mjs --env $HOME/apps/customs-trade-private/.env --data-dir $HOME/customs-trade-data --push --webhook-file $HOME/apps/regulatory-private/feishu.webhook >> $HOME/customs-trade-data/cron.log 2>&1
30 10 12 * * cd $HOME/apps/customs-trade/tools/customs-trade && PATH=$HOME/.local/bin:/usr/bin:/bin node src/run.mjs --env $HOME/apps/customs-trade-private/.env.production --data-dir $HOME/customs-trade-data-prod --push --webhook-file $HOME/apps/regulatory-private/feishu.webhook >> $HOME/customs-trade-data-prod/cron.log 2>&1
15 12 * * * cd $HOME/apps/customs-trade/tools/customs-trade && PATH=$HOME/.local/bin:/usr/bin:/bin node src/check-sync.mjs --data-dir $HOME/customs-trade-data --label 测试环境 --webhook-file $HOME/apps/regulatory-private/feishu.webhook >> $HOME/customs-trade-data/check.log 2>&1
20 12 * * * cd $HOME/apps/customs-trade/tools/customs-trade && PATH=$HOME/.local/bin:/usr/bin:/bin node src/check-sync.mjs --data-dir $HOME/customs-trade-data-prod --label 生产环境 --webhook-file $HOME/apps/regulatory-private/feishu.webhook >> $HOME/customs-trade-data-prod/check.log 2>&1
```

## Alerts (「Supply Smart 服务通知」, the regulatory sync's bot)

- `run.mjs --webhook-file`: a **green** card after every push (environment, window and latest month, rows
  inserted / updated / restored / removed / unchanged; "no change" when Census published nothing new), a **red**
  card when a run fails, naming where it stopped: start (env file, run lock), Census fetch, dry run (nothing
  written) or the real push (some batches may be in; each batch replaces whole code × month slices, so one rerun
  completes it). The error text has every env-file value and any `key=` redacted (`src/alert.mjs`).
- `check-sync.mjs`, daily: a **red** card when the newest run in `runs/` that pushed is older than 33 days (the
  12th to the 12th is at most 31), or there is none: catches the run that never started (crontab, machine down).
  One card per missed push (`overdue-alert.json`). Dry runs don't count as syncs.

First pushes 2026-11-17: test 04:36 UTC, production 09:04 UTC (after main 2544192c deployed migration 0098), each
24,269 rows / 74 codes; a dry run against both afterwards found every row unchanged.
