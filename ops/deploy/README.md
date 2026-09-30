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
5. `JobService` reads the previous PM2 ecosystem file and compares complete process definitions
   (name, script, arguments, working directory, interpreter, environment and log paths).
   It checks the running PM2 inventory for conflicting names before changing anything.
6. Backs up the previous file **byte for byte** to `<pm2.backups>/ecosystem.before-<time>-<uuid>.json`
   with mode `0600`, then atomically replaces `<pm2.file>` with exactly this machine's jobs.
   A missing file is a first deployment; an unreadable, malformed or legacy file stops the deployment.
7. Stops and deletes removed/changed definitions before starting any changed/new jobs. Deleting a stopped
   definition ensures old environment values and executable paths do not survive a replacement.
   Unchanged jobs are never restarted, including jobs that crashed or were stopped manually.
8. Waits for every configured job to be ready. PM2 must report it online; its health file must report
   `WORKER_RUNNING`, the expected role (`api` or `<process>-worker`), that PM2 PID, and a `reportedAt`
   strictly after the process start, no later than now and less than 15 seconds old. A changed job must
   also match the PID and start time recorded by this deployment. Polling is bounded by `health`.

Every job has `autorestart: false`, `watch: false`, fork mode and one instance. A crashed worker stays
stopped. There are no startup, login, resurrection or process-list persistence commands.
The adapter uses [PM2's programmatic API](https://pm2.keymetrics.io/docs/usage/pm2-api/);
no shell control script is involved.

Failures are `JOBS.APPLY_FAILED` with the failed phase/name, file switch state, backup path,
acknowledged stops/deletions/starts and the underlying error. The failed operation can have an unknown
outcome; inspect PM2 before intervening. There is no retry or automatic rollback. A readiness timeout
includes every job's health reason. Already started jobs remain visible for inspection, and the client
always disconnects (disconnect failures are reported too). A backup-write failure leaves the old file
in place; a later file-write failure includes any created backup in the underlying error details.

To recover: keep queues paused, inspect the reported progress and `pm2 list`, stop only the affected
job names, and restore the reported process-file backup if needed. Delete affected stopped definitions
before starting the restored JSON so paths/environment are replaced. Do not rerun a partially applied
deployment as a retry: the process file may already contain the new definitions, and the release
folder already exists. Recovery never undoes a committed database migration; database restore remains
a separate quarantined operation.

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
  "pm2": {
    "file": "/Users/<user>/apps/crawler-v3/live/ecosystem.json",
    "backups": "/Users/<user>/apps/crawler-v3/manual-releases"
  },
  "jobs": [
    {
      "id": "collection-api",
      "app": "api",
      "args": [],
      "env": { "V3_API_CONFIG": "/Users/<user>/apps/crawler-v3/private/api.json" },
      "healthFile": "/Users/<user>/apps/crawler-v3/health/api.json",
      "logs": {
        "out": "/Users/<user>/apps/crawler-v3/logs/api.out.log",
        "error": "/Users/<user>/apps/crawler-v3/logs/api.err.log"
      }
    },
    {
      "id": "pipeline-worker",
      "app": "worker",
      "process": "pipeline",
      "args": [],
      "env": { "V3_PIPELINE_CONFIG": "/Users/<user>/apps/crawler-v3/private/worker.json" },
      "healthFile": "/Users/<user>/apps/crawler-v3/health/pipeline.json",
      "logs": {
        "out": "/Users/<user>/apps/crawler-v3/logs/pipeline.out.log",
        "error": "/Users/<user>/apps/crawler-v3/logs/pipeline.err.log"
      }
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

A worker job names the process it runs; the writer sets `V3_WORKER_PROCESS` from it. The writer also
sets `V3_WORKER_HEALTH_FILE` from the unique `healthFile`. These two variables cannot be overridden in
`env`. API jobs require an absolute `V3_API_CONFIG`; workers require an absolute `V3_PIPELINE_CONFIG`.
`args` defaults to `[]`; job names and health files must be unique. Job name `all` is reserved.
The entry is the release's `apps/<app>/dist/main.js`, `cwd` is that release's source directory, and
`interpreter` is `tools.node`. The adapter creates health/log parent directories before starting.
Comparison covers process definitions, not the contents of referenced private configuration files.
After editing a private file in place, explicitly stop/start the affected job to load the new settings.

### Manual PM2 setup and control

On each Mac that will run the machine config's Node jobs, install the same PM2 version as adapters
(`7.0.4`) and start its daemon **by hand**, under the job owner's account:

```sh
npm install --global pm2@7.0.4
export PM2_HOME="$HOME/apps/crawler-v3/pm2"
pm2 ping
```

Use that same absolute `PM2_HOME` for deployment and every PM2 command. The deploy adapter requires
an already live PID and RPC socket before loading PM2. PM2's API can otherwise spawn a daemon during
`connect`; the adapter blocks its 7.0.4 daemon-launch fallback as well, covering a daemon exit between
preflight and connect. An incompatible client fails closed. Revalidate this guard before upgrading PM2.
No PM2 daemon or worker is launched by importing the adapter or printing a dry run.
Do not configure boot/login startup or save a resurrectable process snapshot. Repeat daemon/job starts
manually after reboot. Never share this PM2 home with another account or run concurrent deploys.

Server 一 runs its API and worker jobs through its own ecosystem file. Server 二 needs its own PM2
installation/home/file only for Node jobs assigned there; Temporal remains Docker and Ego remains
separate. Windows currently runs only the OCR service: this ticket does not migrate that service into
the `api`/`worker` job schema, and its existing manual-start procedure remains necessary.

After pausing/draining the queue through the API (see the private-network guide), control exact names:

```sh
pm2 stop pipeline-worker
pm2 stop collection-api
pm2 list
pm2 start /absolute/path/to/ecosystem.json --only collection-api,pipeline-worker
pm2 describe collection-api
pm2 describe pipeline-worker
```

Substitute this machine's configured names; never stop all processes in a shared daemon. After a manual
start, compare `pm2 describe` with each configured health file using the readiness rule above.
A deploy checks this automatically. The owner explicitly starts a stopped/crashed job when appropriate;
deploying unchanged definitions does not revive it.

For the first cutover, drain work and stop the exact legacy job PIDs with their existing owner-approved
procedure, then verify process/page cleanup before starting replacements. R09 does not adopt or stop
processes outside PM2 or rewrite the legacy resource ledger. Use a **new** `pm2.file` path; keep the old
job list as historical evidence. Later deployments manage only names from the previous ecosystem file.

Migration URLs retain the old tool's local-target policy: `localhost` or loopback IPv4,
`crawler_v3_dev` or `crawler_v3_test`, explicit username/password, no query or fragment overrides.
Stop that database's writers manually before a real migration. The advisory lock coordinates migrators;
it does not stop normal application writes. `pgDump` may be omitted to use `pg_dump` on PATH. Use a version
compatible with the server. Backup subdirectories are `0700`; dumps and manifests are `0600`.

The existing `public.v3_local_migration(name, sha256)` remains the only ledger. Every applied row must match
the ordered release files, including the SHA-256 of their original bytes. Gaps, unknown versions, changed
hashes, restore quarantine and a non-empty unversioned database stop deployment. There is no baseline,
down, rerun or history-repair operation. See [database operations](../../database/v3/OPERATIONS.md).

### Package declarations (R08/R09)

Required dependencies are already declared in this checkout: `@crawl-automation/app` and
`@crawl-automation/adapters` in `ops/deploy`, and `pm2` (`^7.0.4`, installed `7.0.4`) in adapters.
R09 needs no further package.json changes or new type package (PM2 ships its types).
This ticket does not edit manifests or install dependencies. Use the normal locked dependency workflow
on each fresh release. Umzug `3.8.3` remains the migration dependency; there is no additional database CLI.

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

### Browser worker

The browser worker runs on each Mac mini with Ego (both Server 一 and Server 二), using that machine's
private Ego settings. DTC and Amazon Store-page brands use it. Whole Foods waits on its fetch test
(owner decision, 2026-09-30).

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

`storage` is read-only (Review evidence and recheck). `brandScans` writes listing pages to R2. Each
Mac mini's browser worker uses its local Ego browser for DTC and Amazon Store-page brands. The
`wholefoods` settings are retained; Whole Foods waits on its fetch test.

The Postgres change for the private network is in [POSTGRES_PRIVATE_NETWORK.md](POSTGRES_PRIVATE_NETWORK.md).
