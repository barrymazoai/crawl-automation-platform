# Postgres on the private network (no tunnels)

Postgres runs in **Docker on Server 一**, container `crawler-v3-us-postgres-1`, with its existing
persistent volume. The host currently publishes `127.0.0.1:55432`. The private-network change is to
publish **`192.168.68.70:55432`** in **`~/apps/crawler-v3-infra/compose.yaml`**, retaining loopback access.
Changing a host-native PostgreSQL `listen_addresses` or running `pg_ctl` does not change Docker's
port publication. The owner performs these steps by hand; this ticket does not execute them.

## 1. Pause through the API and drain

Keep the API and workers up while draining. Use the configured API URL and call `queue.pause` for
**every active channel**, not just Amazon. This example disables automatic escalation to forced stops:

```sh
export V3_API_URL="http://<api-host>:<api-port>"
curl --fail-with-body -X POST "$V3_API_URL/trpc/queue.pause" \
  -H 'content-type: application/json' \
  --data '{"channel":"amazon","force":false,"graceSeconds":0}'
curl --fail-with-body --get "$V3_API_URL/trpc/queue.status" \
  --data-urlencode 'input={"channel":"amazon"}'
```

Inspect the API response, including any tRPC error. Repeat with each active channel. Wait for zero
running work and completed execution cleanup/permit release; inspect `runs`/`resources` through the
API as necessary. Pause other database writers such as active brand scans too. Do not force-stop or
retry business work just to make this maintenance proceed. A database restart drops connections.

Then stop the exact configured jobs on each affected machine, with the same account and `PM2_HOME`
used for deployment. Keep the API alive until drain verification is complete:

```sh
export PM2_HOME="$HOME/apps/crawler-v3/pm2"
pm2 stop pipeline-worker
pm2 stop collection-api
pm2 list
```

Replace these names with that machine's jobs; do not use a daemon-wide stop. Verify they are stopped.
For machines not yet cut over, complete the legacy handoff in [README.md](README.md) first.

## 2. Back up and edit the Docker Compose publication

On **Server 一**:

```sh
cd ~/apps/crawler-v3-infra
cp -p compose.yaml "compose.yaml.before-private-network-$(date +%Y%m%dT%H%M%S)"
docker compose config --services
```

Retain the existing PostgreSQL image, credentials, volume and service settings. In the existing
`postgres` service, publish both host addresses to the container's PostgreSQL port:

```yaml
services:
  postgres:
    ports:
      - "127.0.0.1:55432:5432"
      - "192.168.68.70:55432:5432"
```

These are edits to the existing service, not a replacement Compose file. Confirm its service key and
internal port with the current file; the commands below use `postgres`. Do not publish `0.0.0.0`,
change the volume, create a replacement database, or use a volume-removing teardown.
Keep the file private: Compose configuration can contain database credentials.

## 3. Keep admission private and authenticated

Ensure `192.168.68.70` is present on Server 一 and reachable by Server 二 over the private network.
Keep the existing password-authenticated PostgreSQL rules. Inspect the container's `pg_hba.conf`
if admission fails; do not add `trust` rules or unauthenticated remote access. If HBA needs changing,
back up that container-side file and restrict the runtime role/database to the required source
addresses with SCRAM authentication. Docker Desktop may translate the client address, so verify the
address observed by PostgreSQL (`SELECT inet_client_addr()`) before relying on HBA `/32` rules.

Restrict host/network access to this published address and port to the required machines; Docker
Desktop owns the port forwarding, not a host-native `postgres` binary. Windows currently only serves
OCR and needs no database access. Never expose this port publicly.

## 4. Recreate only the PostgreSQL container and verify

Port bindings require recreation; a simple container restart is insufficient:

```sh
cd ~/apps/crawler-v3-infra
docker compose config --quiet
docker compose up -d --no-deps --force-recreate postgres
docker compose ps postgres
docker compose port postgres 5432
psql -h 127.0.0.1 -p 55432 -U v3_runtime -d crawler_v3_dev -W -Atc \
  "SELECT current_user, now();"
```

Check both publications with `docker compose ps`/`docker inspect` and verify local access still works.
From **Server 二**, enter the password interactively (never include it in a command or repository):

```sh
psql -h 192.168.68.70 -p 55432 -U v3_runtime -d crawler_v3_dev -W -Atc \
  "SELECT current_user, inet_client_addr(), now();"
```

It must authenticate as `v3_runtime`. Verify disallowed source addresses cannot reach the database.
Do not resume jobs if either connection or admission checks fail.

## 5. Update private configuration, start jobs and verify health

Server 二's private database URL uses `192.168.68.70:55432`; Server 一 retains `127.0.0.1:55432`.
Stop the exact old database tunnel after direct access is verified; remove its entry from the
appropriate owned process configuration. Preserve the old configuration backup.

Start an absent PM2 daemon by hand (`pm2 ping`) with the configured `PM2_HOME`, then start only the
configured jobs from that machine's generated file:

```sh
pm2 start /absolute/path/to/ecosystem.json --only collection-api,pipeline-worker
pm2 describe collection-api
pm2 describe pipeline-worker
```

Check each configured health file: expected role, matching PM2 PID, `WORKER_RUNNING`, a timestamp
after this start and under 15 seconds old. If deploying a new release/config instead, the existing
deploy command calls `JobService` and performs this check automatically. Crashed jobs remain stopped;
there is no automatic restart or boot/login start.

Leave intake paused until the owner authorizes resuming. After that authorization and successful
health checks, call the API for each intended channel:

```sh
curl --fail-with-body -X POST "$V3_API_URL/trpc/queue.resume" \
  -H 'content-type: application/json' --data '{"channel":"amazon"}'
```

## Undo

Keep queues paused and jobs stopped. Restore the selected `compose.yaml.before-private-network-*`
backup, validate it, then recreate only `postgres` with the same command in step 4. Preserve its
volume. Restore changed private connection settings and any separately backed-up HBA rules, verify
loopback access, and only then restart the exact jobs. Database restore is not part of this rollback.
