# Deploying the new version

One command, run by hand on the machine being deployed. Code reaches the machine only by `git clone` of origin
`main`; private settings files arrive by SCP and never go into git. Nothing is set to start at boot or login.

```sh
pnpm --filter @crawl-automation/ops-deploy run deploy <machine-config> <full-commit> --dry-run
pnpm --filter @crawl-automation/ops-deploy run deploy <machine-config> <full-commit> [--migrate]
```

`run` is required: plain `pnpm deploy` is a built-in pnpm command. Run it from any existing checkout of this repository on the machine (the command itself is not part of the
release it builds). Always read the `--dry-run` output first.

## What it does, in order

1. Refuses a release directory that already exists: `<root>/releases/<commit>/source` is always a fresh clone.
2. `git clone --no-checkout <origin>`, checks the commit is on `origin/main`, checks it out detached.
3. `pnpm install --frozen-lockfile`, then builds each app the machine's jobs use (`api`, `worker`).
4. Only with `--migrate`: call `MigrationService` in process using this release's `database/v3` SQL.
   Confirm the target from `migrations.confirm` against `V3_DATABASE_URL`, take advisory lock `73110311`,
   validate the existing history, make one private `pg_dump` backup if SQL is pending, apply all pending
   migrations and their history rows in one transaction, and recheck before committing. No `v3-api db`
   subprocess or new database CLI is used. Any failure stops before the job-list switch.
5. Backs up the job list to `<jobList.backups>/deployment.before-<commit>-<time>.json`, then writes the new one:
   exactly the machine config's jobs, started from the new release. Jobs not in the machine config (old code) are
   removed, and every resource stops naming them.
6. Stops removed jobs; stops and starts only the jobs whose entry or settings changed (`manual-control.mjs`).
7. Asks the control script for each job's status until all are ready, or stops with `DEPLOY.UNHEALTHY`.

Any failure stops the deployment where it is. To go back: restore the backed-up job list and restart those jobs.
This does not undo a committed database migration. Database restore remains a separate, quarantined operation.

`--dry-run` prints the migration step without opening a database connection, creating a backup, or writing
history. The service's separate `status()` operation validates history in a read-only transaction; it never
creates a ledger. A database already at the release's version is validated without replay or another dump.

## Machine config (private, one per machine)

`chmod 600`; placeholders shown.

```json
{
  "machine": "server-one",
  "repository": "git@github.com:<owner>/<repo>.git",
  "root": "/Users/<user>/apps/crawler-v3",
  "tools": { "node": "<absolute node>", "pnpm": "<absolute pnpm>", "git": "/usr/bin/git" },
  "jobList": {
    "file": "/Users/<user>/apps/crawler-v3/live/deployment.json",
    "control": "/Users/<user>/apps/crawler-v3/manual-control.mjs",
    "backups": "/Users/<user>/apps/crawler-v3/manual-releases"
  },
  "jobs": [
    { "id": "collection-api", "app": "api", "env": { "V3_API_CONFIG": "<private api config>" } },
    {
      "id": "pipeline-worker",
      "app": "worker",
      "process": "pipeline",
      "env": { "V3_PIPELINE_CONFIG": "<private worker config>" }
    }
  ],
  "migrations": {
    "backups": "<existing private backup directory>",
    "confirm": "<host>:<port>/<database>",
    "pgDump": "<optional absolute pg_dump executable>"
  },
  "health": { "attempts": 12, "intervalMs": 5000 }
}
```

A worker job names the process it runs; the command sets `V3_WORKER_PROCESS` from it.

Migration URLs retain the old tool's local-target policy: `localhost` or loopback IPv4,
`crawler_v3_dev` or `crawler_v3_test`, explicit username/password, no query or fragment overrides.
Stop that database's writers manually before a real migration. The advisory lock coordinates migrators;
it does not stop normal application writes. `pgDump` may be omitted to use `pg_dump` on PATH. Use a version
compatible with the server. Backup subdirectories are `0700`; dumps and manifests are `0600`.

The existing `public.v3_local_migration(name, sha256)` remains the only ledger. Every applied row must match
the ordered release files, including the SHA-256 of their original bytes. Gaps, unknown versions, changed
hashes, restore quarantine and a non-empty unversioned database stop deployment. There is no baseline,
down, rerun or history-repair operation. See [database operations](../../database/v3/OPERATIONS.md).

### Required package declarations for R08

Add `"@crawl-automation/app": "workspace:*"` and `"@crawl-automation/adapters": "workspace:*"` to
`ops/deploy/package.json` dependencies, then update workspace links/lockfile through the normal dependency
workflow. R08 deliberately leaves package manifests and the lockfile untouched. Umzug `3.8.3` is already
declared by adapters. No additional database CLI dependency is needed.

## Worker processes

The worker config groups roles into a few processes instead of one process per role. Each role polls its own
task queue with its own limits; the process a job runs is named by `V3_WORKER_PROCESS`.

```json
"processes": {
  "pipeline": { "roles": [{ "role": "pipeline", "taskQueue": "v3.pipeline.product.v1",
                            "maxConcurrentActivities": 4 }] }
}
```

Unknown roles are refused. The label roles are added with their workers (phase M5). A config without `processes`
keeps its old `taskQueue` and runs as the `pipeline` process.

## Database: migrations 026–031

| Migration | Adds                                                                                                             | Runtime role (`v3_runtime`) gets                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 026       | comment on `review_record` (raw evidence over the API)                                                           | —                                                                                                                          |
| 027       | shared product queue: `queue_control`, `link_batch`, `queue_item`, `queue_attempt`                               | SELECT, UPDATE on `queue_control`; SELECT, INSERT on `link_batch`; SELECT, INSERT, UPDATE on `queue_item`, `queue_attempt` |
| 028       | listing state: `listing_state_observation`, `listing_state_delivery`                                             | SELECT, INSERT                                                                                                             |
| 029       | `formula_link`                                                                                                   | SELECT, INSERT                                                                                                             |
| 030       | `brand_scan`                                                                                                     | SELECT, INSERT, UPDATE                                                                                                     |
| 031       | `product_history_source`, `_listing`, `_listing_source`, `_observation`, `_observation_source` (metrics history) | SELECT, INSERT                                                                                                             |

Each migration grants these itself when the role exists. Run them with `--migrate`; never replay SQL by hand.

## API private config: new sections

```json
"storage": {
  "r2": { "endpoint": "https://<account>.r2.cloudflarestorage.com", "bucket": "<bucket>", "prefix": "<prefix>/v3" },
  "r2Credentials": { "accessKeyId": "<read-only key>", "secretAccessKey": "<secret>" },
  "storageId": "<the workers' storage ID>"
},
"brandScans": {
  "r2": { "endpoint": "https://<account>.r2.cloudflarestorage.com", "bucket": "<bucket>", "prefix": "<prefix>/v3" },
  "r2Credentials": { "accessKeyId": "<writing key>", "secretAccessKey": "<secret>" },
  "route": { "routeId": "scraperapi-us", "version": "scraperapi/1", "egressId": "scraperapi-us/1",
             "mode": "scraperapi", "managed": true, "countryCode": "us", "sessionNumber": null,
             "responseMode": "html", "providerPolicy": "scraperapi-sync/1" },
  "scraperApi": { "apiKey": "<key>", "allowedOrigins": ["https://www.swansonvitamins.com", "https://www.gnc.com"] },
  "channels": { "gnc": { "premium": false } },
  "ego": { "cliPath": "<absolute ego-browser>", "taskSpaceId": 0 },
  "wholefoods": { "storeId": "10259", "label": "The Alameda", "postalCode": "95126" }
}
```

`storage` is read-only (Review evidence and recheck). `brandScans` writes listing pages to R2. `ego` and
`wholefoods` only work on the machine where the Ego browser runs (Server 二).

The Postgres change for the private network is in [POSTGRES_PRIVATE_NETWORK.md](POSTGRES_PRIVATE_NETWORK.md).
