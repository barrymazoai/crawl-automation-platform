# DTC CDP bridge for Ego Lite

The DTC browser node (`dtc-node.js`) and its Codex capture step (`crawl-products` `worker_cdp`,
Playwright `connectOverCDP`) need a Chrome-style loopback debugging endpoint. Ego Lite has none, so
this bridge serves one on `http://127.0.0.1:<port>/`, backed by one Ego TaskSpace.

- Runs inside `ego-browser nodejs` (an ego Helper (Node) process), started by hand with `start.sh`; no boot/login auto-start.
- Lists, attaches to and closes only pages it created (`/json/new`, `Target.createTarget` → `task.newPage()`) and their popups. The user's tabs and other TaskSpaces are never exposed.
- The instance id is fixed per TaskSpace (`state.json`), so DTC page journals stay valid across bridge restarts. Put it in the DTC `browser.instanceId`.
- Page events come from Ego's polled buffer and are forwarded to attached sessions; events are drained after each command so a command's events precede its response.
- `Page.captureScreenshot` uses Ego's own screenshot. Needs Ego Lite ≥ 0.5.1.13 (0.5.1.11 could not capture on Server 二).
- If Ego reports the space is under user control, the bridge creates the DTC `pauseFile` and refuses further commands. It never takes the space back; the user removes the file after handing control back.

```sh
tools/dtc-ego-bridge/start.sh 9333 <stateDir> <dtc pauseFile> dtc-bridge
curl -H 'Host: 127.0.0.1:9333' http://127.0.0.1:9333/json/version     # webSocketDebuggerUrl ends with the instanceId
touch <stateDir>/STOP                                                  # stop; the bridge renames STOP when it has exited
```

`host-test.mjs` checks the DTC host contract (version guard, `/json/new` marker, `Target.getTargets`,
page call, `/json/close`, absence). `pw-test.mjs` drives the page as the Codex step does. Run both on
the Mac mini, never on the MacBook.
