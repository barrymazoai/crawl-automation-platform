// Two real Chrome launches on Mini, about:blank only. No GNC request or CAPTCHA interaction.
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import assert from "node:assert/strict";
import { NodeSourceProcesses, type LaneGrant } from "@crawl-automation/v3-acquisition";
const [root] = process.argv.slice(2);
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root!, /^\/Users\/barry\/apps\/crawlv3-profile-check\.[A-Za-z0-9]+$/);
const profilesRoot = join(root!, "smoke-profiles");
const driver = new NodeSourceProcesses({ chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, profilesRoot, startupMs: 60000, stopMs: 35000 });
const grant: LaneGrant = { token: "smoke", ownerId: "smoke", sessionId: "smoke-1", laneId: "isolated-smoke",
  route: { routeId: "smoke", version: "1", egressId: "smoke", mode: "static-proxy", managed: true } };
const path = join(profilesRoot, grant.laneId, "profile");
const instances: string[] = [];
for (let n = 1; n <= 2; n++) {
  const sessionRoot = join(root!, `smoke-session-${n}`); await mkdir(sessionRoot, { mode: 0o700 });
  // Deliberately closed loopback proxy: this fixture cannot use any GNC exit lane.
  const browser = await driver.browser({ grant: { ...grant, sessionId: `smoke-${n}` }, proxyUrl: "http://127.0.0.1:9", root: sessionRoot });
  try {
    instances.push(browser.config.instanceId);
    if (n === 1) await writeFile(join(path, "persistence-test-marker"), "retained", { flag: "wx", mode: 0o600 });
    else assert.equal(await readFile(join(path, "persistence-test-marker"), "utf8"), "retained");
  } finally { assert.equal(await browser.stop(), true, "Browser cleanup needs inspection"); }
  await assert.rejects(lstat(join(profilesRoot, grant.laneId, "owner.json")), { code: "ENOENT" });
  await assert.rejects(fetch(`${browser.config.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) }));
}
assert.notEqual(instances[0], instances[1]);
const report = { status: "verified", sameProfile: true, distinctBrowserInstances: true, markerRetained: true,
  bothBrowsersStopped: true, bothProfileLocksReleased: true, businessWorkflows: 0, gncRequests: 0,
  note: "Local file persistence and process lifecycle only; CAPTCHA/cookie acceptance not tested." };
await writeFile(join(root!, "profile-smoke-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
