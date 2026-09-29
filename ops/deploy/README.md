# Deploying the new version

One command, run by hand on the machine being deployed. Code reaches the machine only by `git clone` of origin
`main`; private settings files arrive by SCP and never go into git. Nothing is set to start at boot or login.

```sh
pnpm --filter @crawl-automation/ops-deploy deploy <machine-config> <full-commit> --dry-run
pnpm --filter @crawl-automation/ops-deploy deploy <machine-config> <full-commit> [--migrate]
```

Run it from any existing checkout of this repository on the machine (the command itself is not part of the
release it builds). Always read the `--dry-run` output first.

## What it does, in order

1. Refuses a release directory that already exists: `<root>/releases/<commit>/source` is always a fresh clone.
2. `git clone --no-checkout <origin>`, checks the commit is on `origin/main`, checks it out detached.
3. `pnpm install --frozen-lockfile`, then builds each app the machine's jobs use (`api`, `worker`).
4. Only with `--migrate`: the existing migration tool — `db status`, `db backup`, `db migrate`, `db status` — with
   `V3_DB_CONFIRM` from the machine config and `V3_DATABASE_URL` from the operator's shell (never from a file in git).
5. Backs up the job list to `<jobList.backups>/deployment.before-<commit>-<time>.json`, then writes the new one:
   exactly the machine config's jobs, started from the new release. Jobs not in the machine config (old code) are
   removed, and every resource stops naming them.
6. Stops removed jobs; stops and starts only the jobs whose entry or settings changed (`manual-control.mjs`).
7. Asks the control script for each job's status until all are ready, or stops with `DEPLOY.UNHEALTHY`.

Any failure stops the deployment where it is. To go back: restore the backed-up job list and restart those jobs.

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
  "migrations": { "backups": "<private backup directory>", "confirm": "<host>:<port>/<database>" },
  "health": { "attempts": 12, "intervalMs": 5000 }
}
```

A worker job names the process it runs; the command sets `V3_WORKER_PROCESS` from it.

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

Each migration grants these itself when the role exists. Run them with `--migrate` (or the migration tool
directly); never replay SQL by hand.

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
