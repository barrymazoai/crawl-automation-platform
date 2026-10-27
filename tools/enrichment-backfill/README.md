# Product-enrichment/4 backfill

Owner 2026-10-26: re-enrich every product sent to Supply Smart on an older enrichment protocol (about 49,000:
never enriched, then /2, then /3), with the production model (`gpt-5.6-luna`, `medium`, no fast, no other model),
three at a time so the crawl keeps its model slots. Background: `docs/quality/2026-10-26-enrichment-v4.md`.

`run.mjs` (Node built-ins only), on Server 一, from the deployed release:

1. On the first start it takes the product list once (read-only SQL, the `enrichment.outdated` order) into
   `plan.json`. A product is tried once: a failure is written to `failures.jsonl` and never picked again.
2. Batches of 100: each product goes through `enrichment.run` and is followed with `enrichment.workflow` until its
   workflow ends (at most 30 minutes); at most `--concurrency` at a time.
3. After a batch, the Supply Smart products of its enriched collections are previewed with
   `productSync.updateEnrichment {productIds, dryRun: true}` and then written with the same request. A product
   Supply Smart no longer has (`NOT_FOUND`) is recorded in `failures.jsonl` and skipped (owner 2026-10-27); any other
   refused product, or a write that differs from its preview, stops the run; the next start finishes that update first.
4. It stops at a checkpoint (`--stop-after`, default 5,000 products per start), when a batch has more than 10%
   failed enrichments, when the 5-minute load of Server 一 passes 28, on a crawler API or Supply Smart error, or
   when the file `STOP` exists in the state folder (in-flight products finish first).

```sh
cd ~/apps/crawler-v3/releases/<sha>/source/tools/enrichment-backfill
PATH=$HOME/.local/bin:$PATH nohup node run.mjs --state-dir $HOME/enrichment-v4-backfill >> $HOME/enrichment-v4-backfill/nohup.log 2>&1 &
# progress
cat ~/enrichment-v4-backfill/progress.json; tail ~/enrichment-v4-backfill/run.log
# pause (finishes the products in flight, then stops)
touch ~/enrichment-v4-backfill/STOP
# resume: remove STOP and start it again; it continues from progress.json
```

Files in the state folder: `plan.json`, `progress.json` (`next` index, counts, a pending Supply Smart update),
`outcomes.jsonl` (every product), `failures.jsonl`, `updates.jsonl` (each preview and write), `run.log`.
