# Crawl round reports (KAN-229)

One report per finished round to Supply Smart's `crawlReport.submit`, for its admin **Data updates**
page (contract: supply-smart-mono `docs/packages/database-api/domains/crawl-run-report.md`). A plain
script, no model. Supply Smart counts what each round changed (new records, new brands, new
companies) from its own ingest ledgers; the crawler reports what it did. The stats definitions and
open questions are in `docs/spark/2026-10-29-kan229-crawl-round-report.md`.

```sh
node src/report.mjs --state-dir <dir> [--dry-run] [--out <file>]
  [--supply-smart-env <file> | --local-db-env <file>]
  [--crawler-api http://127.0.0.1:4188/trpc | --rounds-file <rounds.list answer>]
  [--regulatory-data <dir>] [--ingredient-intel-data <dir>] [--days 120] [--partial-share 0.05]
  [--only <runId,…>]
```

| Source | Read from | Report `runId` |
|---|---|---|
| amazon, costco, gnc, swanson, wholefoods, dtc | crawler API `rounds.list` (read-only) | `<channel>-<first start, to the minute>` |
| regulatory | `<regulatory-data>/sync/runs/*`, `runs/*/manifest.json`, `last-sync.json` | the pushed crawl run id |
| branded_ingredient | `<ingredient-intel-data>/runs/*/report.json` (pushed runs) | the job's run id |
| clinical_trial | the same reports | the delivery id (`deliver-…`) |

- A round of the crawler is reported once every product's first run and every brand scan of it has
  settled. Later changes (a requeue fixed a product, more pushes arrived) change the report, and the
  changed report is sent again; Supply Smart replaces the stored one.
- `<state-dir>/sent.json` keeps a hash per `(source, runId)`. An unchanged report is not sent again;
  a failed send is not recorded, so the next run retries it. The crawler version is not hashed.
- A source that cannot be read is logged and the others are still reported; the run then exits 1.
- Sales channels and DTC send `ingestWindow` [round start, next round start) (the latest round: up to
  now, so it is sent again every run); Supply Smart sums every ingest run of the channel in it,
  listing-state runs included. Regulatory is matched by `breakdown.supply_smart_push.sync_run_ids`.
  Regulatory and ingredient-intel send `schedule.everyDays: 3.5` (Tuesday and Friday).
- `--only` handles just the listed runIds, e.g. to check one round by hand.
- `--dry-run` prints every report (`would` = would be sent) and writes no state.
- `--local-db-env` (local test only): writes into a **localhost** Supply Smart product database's
  `crawl_report` table, read from its `packages/product-db/.env`. Supply Smart's counts stay empty.
  Use a separate `--state-dir`.
- The service key comes from the private env file (`SUPPLY_SMART_DATABASE_RPC_URL`,
  `SUPPLY_SMART_API_KEY`, the product-sync key) and is never logged.

Install: `pnpm install --ignore-workspace` in this folder (not part of the pnpm workspace, like the
other tools).
