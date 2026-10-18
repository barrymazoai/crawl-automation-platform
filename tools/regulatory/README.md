# Regulatory collector

Collects public regulatory events for the Supply Smart Regulatory module
(KAN-215) into JSONL files. It does not write any database and does no entity
matching: company names, addresses and websites are kept as the source gives them.
Runs on Server 一, started by hand. No scheduler is installed yet.

| Kind | Source (`source`) | What is read |
|---|---|---|
| `warning_letter` | `fda_warning_letters` | FDA warning letter list (DataTables JSON behind the warning-letter page) + each letter page, except letters from the Tobacco, Devices, Biologics and Veterinary centers |
| `gras` | `fda_gras_notices` | GRAS notice CSV export + each notice page (for the FDA response letter link) |
| `ndi` | `fda_ndi_notifications` | NDI page → its current XLSX (looked up by file name each run) |
| `lawsuit` | `ca_ag_prop65` | CA AG Prop 65 60-day notice search results, month by month; supplement-type products only |
| `lawsuit` | `trade_press_rss` | NutraIngredients and SupplySide Supplement Journal RSS; litigation/enforcement items only; headline, the feed's own summary and the link |

## Run

```sh
cd ~/apps/regulatory/tools/regulatory
pnpm install --frozen-lockfile --ignore-workspace   # own lockfile; not part of the workspace
node src/run.mjs --data-dir ~/regulatory-data --mode backfill      # first run, monthly reconcile
node src/run.mjs --data-dir ~/regulatory-data --mode incremental   # regular runs
```

Options: `--sources a,b` (names above), `--refetch-pages` (read letter/notice
pages again instead of using the cached copy), `--offline` (cache only, no
requests; used to re-run extraction after a rule change).

`backfill` reads every warning letter in the list, every GRAS and NDI row, 12
months of Prop 65 notices, and up to 40 pages of the SupplySide feed.
`incremental` reads the same lists but fetches only letter/notice pages it has
not seen (or whose list row changed), and the last 45 days of Prop 65 notices.

Requests: one per second per host, 60 s timeout, 3 retries with backoff for
network errors, 429 and 5xx. 401/403/451 are counted as blocked and never
retried; three blocks in a row stop that source and the manifest says so. No
paid proxy is used.

## Output (`--data-dir`)

- `<kind>.jsonl`: every record ever seen, one per `source` + `source_key`,
  rewritten atomically each run. `first_seen_at`, `last_seen_at`,
  `changed_at` and `content_hash` are bookkeeping; `published_date` of the
  inventory sources (GRAS, NDI) is the first-seen date.
- `manifest.json`: the latest run (per source: status, counts new/updated/
  unchanged, date coverage, requests and problems, field completeness).
- `runs/<run-id>/`: `run.log`, `manifest.json`, `changes/<kind>.jsonl` (only
  records that are new or changed in that run).
- `cache/`: raw responses (gzip), used for `--offline` re-extraction.

The extraction rules are in `src/sources/*-rules.mjs`; every violation type,
ingredient and scope decision keeps the sentence it came from in
`details.evidence` / `details.scope_quote`. See
`docs/plans/regulatory-crawl.md` for the keyword lists and the checks.
