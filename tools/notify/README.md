# Feishu notifications

Cards to the 「Supply Smart 服务通知」 Feishu group (formerly the 爬虫 group; same
custom-bot webhook). Plain scripts, no model, no dependencies beyond Node 22+.

- `feishu.mjs` — the sender: a coloured header and a markdown body, shared with
  `tools/regulatory` (sync and overdue cards). The webhook URL is read from a
  private file outside git and never logged.
- `crawler.mjs` — crawler V3 progress (owner 2026-10-19: moved from the Mac mini
  `barry@192.168.0.25` launchd jobs to Server 一, same content and frequency).

## crawler.mjs

```sh
node crawler.mjs report --state-dir <dir> --webhook-file <file> [--at-beijing 9,15] [--dry]
node crawler.mjs alert  --state-dir <dir> --webhook-file <file> [--dry]
```

It reads Server 一 locally: `pm2 jlist` (pm2 from `Crawler Node.app`), the API at
`127.0.0.1:4188` (`productSync.status`, `resources.list`, `queue.status` for the
six channels), and `tailscale status` plus ping for Server 二 and Windows OCR.

- `report`: which channels run; per channel completed, change since the last
  report, queued, running, Review; Supply Smart sync verified / failed; pm2
  processes online, release, restarts; problems. The comparison base is
  `<state-dir>/report-last.json`. With `--at-beijing 9,15` it only reports at
  those Beijing hours, so cron runs it hourly and the US daylight-saving change
  does not move it.
- `alert`: a problem is posted after two checks in a row see it, and its
  recovery after two checks in a row don't (`<state-dir>/alert-last.json`).
- Problems: a host offline, a pm2 process not online, an unhealthy resource
  (resources whose reason starts with `retired`, such as the old DTC v2
  browsers, are skipped), a channel queue that cannot be read.
- `--dry` prints the card and writes no state. A card the webhook refuses fails
  the run without saving state.

Server 一 cannot report itself being down; the Mac mini service monitor
(`com.barry.notify.service-monitor`, every 4 h) covers the hosts.

## On Server 一

- Code: `~/apps/notify` (a `git clone` of this repo, updated with `git pull`).
- Webhook: `~/apps/regulatory-private/feishu.webhook` (mode 600, shared with the
  regulatory sync; copied by SCP, never in git).
- State and logs: `~/notify-data/state/`, `~/notify-data/logs/`.
- crontab (Server 一 runs on US Central time; the Beijing hour is checked by the
  script):

```cron
0 * * * * cd $HOME/apps/notify/tools/notify && PATH=$HOME/.local/bin:/usr/bin:/bin node crawler.mjs report --at-beijing 9,15 --state-dir $HOME/notify-data/state --webhook-file $HOME/apps/regulatory-private/feishu.webhook >> $HOME/notify-data/logs/report.log 2>&1
*/15 * * * * cd $HOME/apps/notify/tools/notify && PATH=$HOME/.local/bin:/usr/bin:/bin node crawler.mjs alert --state-dir $HOME/notify-data/state --webhook-file $HOME/apps/regulatory-private/feishu.webhook >> $HOME/notify-data/logs/alert.log 2>&1
```
