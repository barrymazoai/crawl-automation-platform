import { readFile, writeFile, open, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createConnection } from "node:net";
import assert from "node:assert/strict";
const [root] = process.argv.slice(2);
assert.equal(root, "/Users/barry/apps/crawlv3-gnc-e2e.FzqLa3");
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
const manifest = JSON.parse(await readFile("/Users/barry/apps/crawlv3-gnc-manual-76ENrC/lanes.json", "utf8"));
const lane = manifest.lanes.find(l => l.label === "Virginia");
assert.equal(lane.root, "/Users/barry/apps/crawlv3-gnc-manual-76ENrC/lane-syo4TS");
const y = createRequire("/Users/barry/apps/crawl-platform-v4-parallel/apps/backend/package.json")("yaml");
const cfg = y.parse(await readFile(join(lane.root, "proxy.yaml"), "utf8"));
const proxy = cfg.proxies.find(p => p.name === lane.name);
assert.equal(proxy.server, lane.exitIp); assert.equal(proxy["dialer-proxy"], lane.front);
assert.deepEqual(cfg.rules, ["MATCH," + lane.name]);
assert.equal(cfg["mixed-port"], lane.proxyPort);
assert.equal(cfg["external-controller"], `127.0.0.1:${lane.apiPort}`);
assert.ok((await lstat(join(lane.root, "profile"))).isDirectory());
const reachable = port => new Promise(resolve => { const s = createConnection({ host: "127.0.0.1", port });
  const end = ok => { s.destroy(); resolve(ok); }; s.once("connect", () => end(true)); s.once("error", () => end(false)); s.setTimeout(1000, () => end(false)); });
for (const port of [lane.proxyPort, lane.apiPort, lane.cdpPort]) assert.equal(await reachable(port), false, "Already running: inspect existing process instead");
await writeFile(join(root, "restore-intent.json"), JSON.stringify({ at: new Date().toISOString(), lane: "Virginia" }), { flag: "wx", mode: 0o600 });
const owned = [];
async function launch(name, executable, args, env = process.env) {
  const log = await open(join(root, `${name}.log`), "ax", 0o600);
  const child = spawn(executable, args, { detached: true, stdio: ["ignore", log.fd, log.fd], env });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  owned.push({ name, pid: child.pid }); child.unref(); await log.close(); return child;
}
async function until(check) { const deadline = Date.now() + 20000; while (!await check()) {
  if (Date.now() > deadline) throw Error("PROCESS_NOT_READY"); await new Promise(r => setTimeout(r, 250)); } }
try {
  await launch("private-proxy", "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo", ["-d", lane.root, "-f", join(lane.root, "proxy.yaml")]);
  await until(() => reachable(lane.apiPort));
  const rules = await (await fetch(`http://127.0.0.1:${lane.apiPort}/rules`, { signal: AbortSignal.timeout(5000) })).json();
  assert.deepEqual(rules.rules.map(r => [r.type, r.proxy]), [["Match", lane.name]]);
  await launch("gnc-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    `--user-data-dir=${join(lane.root, "profile")}`, `--remote-debugging-port=${lane.cdpPort}`, "--remote-debugging-address=127.0.0.1",
    `--proxy-server=http://127.0.0.1:${lane.proxyPort}`, "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble", "about:blank",
  ], { ...process.env, TZ: "America/New_York" });
  await until(() => reachable(lane.cdpPort));
  const v = await (await fetch(`http://127.0.0.1:${lane.cdpPort}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  const instanceId = new URL(v.webSocketDebuggerUrl).pathname.split("/").at(-1);
  assert.match(instanceId, /^[a-f0-9-]+$/);
  const result = { at: new Date().toISOString(), status: "ready", owned, laneRoot: lane.root, proxyPort: lane.proxyPort,
    apiPort: lane.apiPort, browser: { endpoint: `http://127.0.0.1:${lane.cdpPort}`, instanceId, sessionId: `browser-${instanceId}` }, businessNavigations: 0 };
  await writeFile(join(root, "restored.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(result));
} catch {
  for (const child of owned.reverse()) try { process.kill(child.pid, "SIGTERM"); } catch {}
  await writeFile(join(root, "restore-failure.json"), JSON.stringify({ owned, action: "inspect; no automatic relaunch" }), { flag: "wx", mode: 0o600 });
  console.error("RESTORE_FAILED"); process.exitCode = 1;
}
