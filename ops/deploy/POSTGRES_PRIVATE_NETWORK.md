# Postgres on the private network (no tunnels)

Server 一's Postgres listens only on `127.0.0.1` today, so Server 二 reached it through an SSH tunnel. The owner's
rule: machines talk directly on the private network; no tunnels. These are the commands the owner runs by hand on
Server 一. Placeholders:

| Placeholder            | Meaning                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `<SERVER1_PRIVATE_IP>` | Server 一's address on the private network (the one Server 二 reaches it by)                                                                 |
| `<SERVER2_PRIVATE_IP>` | Server 二's private address                                                                                                                  |
| `<WINDOWS_PRIVATE_IP>` | the Windows machine's private address — only if a service there ever needs the database; today Windows runs only the OCR API, which does not |
| `<PORT>`               | the cluster's port (today 55432)                                                                                                             |
| `<DATABASE>`           | `crawler_v3_dev`                                                                                                                             |

## 0. Before you start

Stop new work and let running work end: pause the queues (`crawler queue pause`) and wait until nothing is running,
then stop the jobs (`node manual-control.mjs stop all`). A Postgres restart drops every connection.

## 1. Find the cluster's files (read-only)

```sh
psql -h 127.0.0.1 -p <PORT> -U postgres -d <DATABASE> -Atc \
  "SHOW config_file; SHOW hba_file; SHOW data_directory; SHOW listen_addresses; SHOW password_encryption;"
```

Back up both files before changing them:

```sh
cp -p <config_file> <config_file>.before-private-network
cp -p <hba_file> <hba_file>.before-private-network
```

## 2. Listen on the private address as well

```sh
psql -h 127.0.0.1 -p <PORT> -U postgres -d <DATABASE> -c \
  "ALTER SYSTEM SET listen_addresses = '127.0.0.1,<SERVER1_PRIVATE_IP>';"
psql -h 127.0.0.1 -p <PORT> -U postgres -d <DATABASE> -c "ALTER SYSTEM SET password_encryption = 'scram-sha-256';"
```

## 3. Admit only the other machines, with passwords

Append to `<hba_file>` (one line per machine; `/32` = exactly that address):

```
host  <DATABASE>  v3_runtime  <SERVER2_PRIVATE_IP>/32  scram-sha-256
# host  <DATABASE>  v3_runtime  <WINDOWS_PRIVATE_IP>/32  scram-sha-256   # only if Windows ever needs it
```

Give the runtime role a SCRAM password if it has none (typed at the prompt, never on the command line):

```sh
psql -h 127.0.0.1 -p <PORT> -U postgres -d <DATABASE> -c "\\password v3_runtime"
```

Keep the password in the private config files only.

## 4. Firewall

macOS Application Firewall: allow incoming connections for the `postgres` binary of this cluster
(System Settings → Network → Firewall → Options), or leave the firewall as it is if it is off. The private network is
the only network that reaches `<SERVER1_PRIVATE_IP>`; never add a public address to `listen_addresses`.

## 5. Restart (listen_addresses needs a restart) and check

```sh
pg_ctl -D <data_directory> restart -m fast
psql -h 127.0.0.1 -p <PORT> -U postgres -d <DATABASE> -Atc "SHOW listen_addresses;"
```

From **Server 二**:

```sh
read -rs PGPASSWORD && export PGPASSWORD
psql "host=<SERVER1_PRIVATE_IP> port=<PORT> dbname=<DATABASE> user=v3_runtime" -Atc "SELECT current_user, now();"
unset PGPASSWORD
```

It must print `v3_runtime` and the time. From any other address the connection must be refused.

## 6. Point Server 二's services at the private address

In Server 二's private config files, set the database host to `<SERVER1_PRIVATE_IP>`; Server 一's own services keep
`127.0.0.1`. Stop any SSH tunnel process that was used for the database and remove it from Server 二's job list.
Then start the jobs again (`node manual-control.mjs start …`) and resume the queues.

## Undo

Restore the two `.before-private-network` files, `ALTER SYSTEM RESET listen_addresses;`, restart as in step 5.
