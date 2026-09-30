// Explicitly authorized, single-domain change on the Mini. Secrets never leave the machine.
import { readFile, copyFile, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const [flag, patchExecutable] = process.argv.slice(2);
assert.equal(flag, "--apply-existing-aix");
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(patchExecutable ?? "", /^\/Users\/barry\/\.codex\/tmp\/arg0\/codex-arg0[a-zA-Z0-9]+\/apply_patch$/);
const yaml = createRequire("/Users/barry/apps/crawl-platform-v4-parallel/apps/backend/package.json")("yaml");
const base = "/Users/barry/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev";
const runtimePath = join(base, "clash-verge.yaml"), rulesPath = join(base, "profiles/r1qq236ZLr8B.yaml");
const rule = "DOMAIN,altaria.proxy.rlwy.net,AI/X专用";
const profiles = yaml.parse(await readFile(join(base, "profiles.yaml"), "utf8"));
assert.equal(profiles.current, "RxCXE1PR7D7Y");
assert.equal(profiles.items.find(p => p.uid === profiles.current)?.option?.rules, "r1qq236ZLr8B");
const originalRuntime = await readFile(runtimePath, "utf8"), originalRules = await readFile(rulesPath, "utf8");
const cfg = yaml.parse(originalRuntime), persistent = yaml.parse(originalRules);
assert.equal(cfg["external-controller-unix"], "/tmp/verge/verge-mihomo.sock");
assert.equal(cfg.tun?.enable, true);
assert.ok(cfg["proxy-groups"].some(p => p.name === "AI/X专用" && p.type === "select"));
assert.ok(!cfg.rules.some(r => r.includes("altaria.proxy.rlwy.net")));
assert.ok(!persistent.prepend.some(r => r.includes("altaria.proxy.rlwy.net")));

function api(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: cfg["external-controller-unix"], path, method,
      headers: { Authorization: `Bearer ${cfg.secret}`, "Content-Type": "application/json" } }, response => {
      let data = "";
      response.on("data", chunk => { data += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(Error(`CONTROL_${response.statusCode}`));
        try { resolve(data ? JSON.parse(data) : null); } catch { reject(Error("CONTROL_RESPONSE_INVALID")); }
      });
    });
    request.setTimeout(15000, () => request.destroy(Error("CONTROL_TIMEOUT")));
    request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
  });
}
const selectors = p => Object.fromEntries(Object.entries(p.proxies).filter(([, v]) => v.type === "Selector").map(([k, v]) => [k, v.now]));
const before = selectors(await api("/proxies"));
assert.ok(before["AI/X专用"]);
const backup = await mkdtemp(join(base, "temporal-route-backup-"));
await chmod(backup, 0o700);
await copyFile(runtimePath, join(backup, "runtime.yaml"));
await copyFile(rulesPath, join(backup, "rules.yaml"));
await chmod(join(backup, "runtime.yaml"), 0o600); await chmod(join(backup, "rules.yaml"), 0o600);
const report = { at: new Date().toISOString(), backup, rule, selectorBefore: before["AI/X专用"], status: "prepared" };
try {
  // Reject concurrent file edits before applying only two one-line additions.
  assert.equal(await readFile(runtimePath, "utf8"), originalRuntime);
  assert.equal(await readFile(rulesPath, "utf8"), originalRules);
  const patch = `*** Begin Patch\n*** Update File: ${rulesPath}\n@@\n prepend:\n+- ${rule}\n*** Update File: ${runtimePath}\n@@\n rules:\n+- ${rule}\n*** End Patch`;
  execFileSync(patchExecutable, [patch], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
  const nextRuntime = yaml.parse(await readFile(runtimePath, "utf8")), nextRules = yaml.parse(await readFile(rulesPath, "utf8"));
  assert.deepEqual(nextRuntime, { ...cfg, rules: [rule, ...cfg.rules] });
  assert.deepEqual(nextRules, { ...persistent, prepend: [rule, ...persistent.prepend] });
  execFileSync("/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo", ["-t", "-d", base, "-f", runtimePath],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  report.status = "validated";
} catch {
  await copyFile(join(backup, "runtime.yaml"), runtimePath);
  await copyFile(join(backup, "rules.yaml"), rulesPath);
  report.status = "validation-failed-files-restored";
  await writeFile(join(backup, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report)); process.exit(1);
}
try {
  await api("/configs?force=true", "PUT", { path: runtimePath });
  const active = await api("/rules"), after = selectors(await api("/proxies"));
  report.ruleActive = active.rules[0]?.type === "Domain" && active.rules[0]?.payload === "altaria.proxy.rlwy.net" && active.rules[0]?.proxy === "AI/X专用";
  report.selectorAfter = after["AI/X专用"];
  report.changedSelectors = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
  report.status = report.ruleActive && report.changedSelectors.length === 0 ? "applied" : "verification-required";
} catch { report.status = "reload-verification-required"; }
await writeFile(join(backup, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
if (report.status !== "applied") process.exitCode = 1;
