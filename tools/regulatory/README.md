# Regulatory collector

Collects public regulatory events for the Supply Smart Regulatory module
(KAN-215) into JSONL files and pushes them to Supply Smart's `regulatory.ingest`
(KAN-218). It writes no database itself and does no entity matching: company
names, addresses and websites are kept as the source gives them; Supply Smart
matches them. Runs on Server 一: `src/sync.mjs` from crontab, Tuesday and
Friday 18:00 US Central (owner 2026-10-19).

| Kind | Source (`source`) | What is read |
|---|---|---|
| `warning_letter` | `fda_warning_letters` | FDA warning letter list (DataTables JSON behind the warning-letter page) + each letter page, except letters from the Tobacco, Devices, Biologics and Veterinary centers |
| `gras` | `fda_gras_inventory` | GRAS notice CSV export + each notice page (for the FDA response letter link) |
| `ndi` | `fda_ndi_list` | NDI page → its current XLSX (looked up by file name each run) |
| `lawsuit` | `ca_prop65` | CA AG Prop 65 60-day notice search results, month by month; supplement-type products only |
| `lawsuit` | `media:nutraingredients`, `media:supplysidesj` (option name `media`) | NutraIngredients and SupplySide Supplement Journal RSS; litigation/enforcement items only; headline, the feed's own summary and the link |

## Run

```sh
cd ~/apps/regulatory/tools/regulatory
pnpm install --frozen-lockfile --ignore-workspace   # own lockfile; not part of the workspace
node src/run.mjs --data-dir ~/regulatory-data
```

Options: `--sources a,b` (names above), `--refetch-pages` (read letter/notice
pages again instead of using the cached copy), `--offline` (cache only, no
requests; used to re-run extraction after a rule change).

Every run reads the complete warning-letter, GRAS and NDI lists, 12 months of
Prop 65 notices (~70 requests) and both RSS feeds, and fetches only the
letter/notice pages it has not seen (or whose list row changed). The feeds have
no archive: NutraIngredients shows its latest 20 items (about 3 days),
SupplySide its latest 50 (about 7 weeks), so media coverage only grows from the
first run on.

Requests: one per second per host, 60 s timeout, 3 retries with backoff for
network errors, 429 and 5xx. 401/403/451 are counted as blocked and never
retried; three blocks in a row stop that source and the manifest says so. No
paid proxy is used.

## Output (`--data-dir`)

- `<kind>.jsonl`: every record ever seen, one per `source` + `source_key`,
  rewritten atomically each run. `first_seen_at`, `last_seen_at`,
  `changed_at` and `content_hash` are bookkeeping; `published_date` of the
  inventory sources (GRAS, NDI) is the first-seen date. Every run marks
  warning letters, GRAS and NDI records that are no longer in the source list
  with `removed_at`; nothing is deleted. When a list comes back more than 5%
  shorter than the records it listed before, nothing is marked and the
  manifest entry gets `removals_skipped`. Every `lawsuit` record has
  `status: alleged`; a Prop 65 notice's progress is `details.case_progress`.
- `manifest.json`: the latest run (per source: status, counts new/updated/
  unchanged, date coverage, requests and problems, field completeness).
- `runs/<run-id>/`: `run.log`, `manifest.json`, `changes/<kind>.jsonl` (only
  records that are new or changed in that run).
- `cache/`: raw responses (gzip), used for `--offline` re-extraction.

## Ingredients read by a model (warning letters)

```sh
node src/ai-ingredients.mjs --data-dir ~/regulatory-data --scope dietary_supplement \
  --model gpt-5.6-luna --effort medium            # or --slugs a,b
node src/run.mjs --data-dir ~/regulatory-data --sources fda_warning_letters --offline
```

The first command reads each letter from the cache (no web request) and asks
`gpt-5.6-luna` (effort medium) through the Codex CLI logged in on the machine for the
ingredients the letter names, each with a sentence from the letter. Model and
effort have no defaults and must be given (the machine's Codex default is a
dearer model); an answer from any other model or effort, as Codex reports it,
is refused. An item is
kept only when that sentence is in the letter word for word (quote marks and
FDA's [bracket] edits aside) and contains the name as written; a shortened
quote is replaced by the letter's best-matching sentence (`quote_repaired`).
Results go to `ai/warning-letter-ingredients/<slug>.json`, with the dropped
items and reasons. A letter that already has an answer for its current text
and prompt is skipped, whichever model gave it (`--redo` reads it again).

The second command merges them: `details.ingredients_mentioned` and the
ingredient `evidence` then come from the model (`ingredients_source:
model:...`, `ingredient_details` with role per ingredient), and the lexicon
result stays in `details.ingredients_rule`. Letters without a current model
answer keep the lexicon result (`ingredients_source: rule`). New letters need
the first command again before they get model ingredients.

## Scheduled sync (`src/sync.mjs`)

```sh
node src/sync.mjs --data-dir ~/regulatory-data \
  --supply-smart-env ~/apps/crawler-v3/manual-releases/brand-enrichment/.env.brand-enrichment \
  --webhook-file ~/apps/regulatory-private/feishu.webhook
# --dry-run: push as dry runs only; --skip-crawl, --no-model: leave out those steps
```

1. Collects every source (`src/run.mjs`).
2. Supplement-type letters without model ingredients are read (gpt-5.6-luna,
   medium, one at a time) and merged: the two commands above. Food letters
   are not sent to the model.
3. Pushes to Supply Smart `regulatory.ingest` (contract: supply-smart-mono
   `docs/packages/database-api/domains/regulatory-ingest.md`) with the service
   key product sync uses (`SUPPLY_SMART_DATABASE_RPC_URL`, `SUPPLY_SMART_API_KEY`
   in the private env file; the key is never logged). Only records whose
   `content_hash`, `published_date`, `first_seen_at` or `removed_at` differ from
   what Supply Smart last confirmed (`sync/ledger.json`) are sent, cut into
   numbered batches of ≤ 500 under the manifest's `run_id`; the cut is kept in
   `sync/runs/<run-id>/` so a retry sends the same batches. Every batch goes as
   a dry run first; any error stops before a real write. 429/5xx/timeouts are
   retried with the same batch (Supply Smart counts a batch once).
4. Compares Supply Smart's per-kind totals (`regulatory.overview`, food
   letters included) with the records in the files that are not removed.
5. Writes `last-sync.json` (every step's result, `problems`, `summary_text`)
   and sends the 「Supply Smart 服务通知」 Feishu group a card from Server 一: a short summary
   (letters read and tokens included), or the problems in red. The webhook URL
   is the one the crawler notifications use, kept in a private file outside
   git and never logged. A problem in one step does not stop later steps whose
   input is still sound; the exit code is 1 when there was any problem.

Daily overdue check (crontab, 12:00 US Central):

```sh
node src/check-sync.mjs --data-dir ~/regulatory-data --webhook-file ~/apps/regulatory-private/feishu.webhook
```

Every full sync (it collected and pushed; not `--dry-run` or `--skip-crawl`)
also writes `sync/last-full-sync.json`. When that file is missing or older than
102 h (the longest normal gap is Friday → Tuesday, 96 h), the group gets one
red card per missed sync. A machine that is down sends nothing; the crawler's
host checks cover that.

The extraction rules are in `src/sources/*-rules.mjs`; every violation type,
ingredient and scope decision keeps the sentence it came from in
`details.evidence` / `details.scope_quote`. See
`docs/plans/regulatory-crawl.md` for the keyword lists and the checks.
