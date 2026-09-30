// Read-only prerequisite checks. No workflow submission, browser navigation, OCR upload or model request.
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";

const [root, reportName = "preflight.json", networkMode = "default-clash"] = process.argv.slice(2);
if (!root || !isAbsolute(root) || !/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("MINI_ONLY");
if (!/^preflight(?:-[a-z0-9-]+)?\.json$/.test(reportName)) throw Error("INVALID_REPORT_NAME");
if (!["default-clash", "legacy-manual"].includes(networkMode)) throw Error("INVALID_NETWORK_MODE");
const report = { at: new Date().toISOString(), networkMode, checks: {}, submittedWorkflows: 0, browserNavigations: 0, ocrUploads: 0, modelCalls: 0 };
async function tcp(host, port) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = status => { if (done) return; done = true; socket.destroy(); resolve(status); };
    socket.setTimeout(5000); socket.once("connect", () => finish("reachable"));
    socket.once("timeout", () => finish("timeout")); socket.once("error", e => finish(e.code ?? "unreachable"));
  });
}
const deployment = JSON.parse(await readFile(join(root, "deployment.json"), "utf8"));
for (const [name, file] of [["r2Config", "/Users/barry/apps/crawlv3-gnc-live-ioVGhu/.env.r2"], ["codexAuth", "/Users/barry/.codex/auth.json"]]) {
  try { const s = await lstat(file); report.checks[name] = { regular: s.isFile() && !s.isSymbolicLink(), private: !(s.mode & 0o077) }; }
  catch { report.checks[name] = { present: false }; }
}
if (networkMode === "legacy-manual") {
  const manifest = JSON.parse(await readFile("/Users/barry/apps/crawlv3-gnc-manual-76ENrC/lanes.json", "utf8"));
  const lane = manifest.lanes.find(l => l.label === "Virginia");
  if (!lane) throw Error("LANE_MISSING");
  report.checks.browser = await tcp("127.0.0.1", lane.cdpPort);
  report.checks.privateProxy = await tcp("127.0.0.1", lane.proxyPort);
  report.checks.privateProxyControl = await tcp("127.0.0.1", lane.apiPort);
} else {
  // A pooled browser is created only after submission preparation. Never require
  // stale manual CDP/sidecar ports, nor launch a browser during this preflight.
  report.checks.defaultClashListeners = await Promise.all([17891, 17892, 17893, 17894].map(async port => ({ port, status: await tcp("127.0.0.1", port) })));
  report.checks.egress = "deferred-to-lane-allocation";
}
try {
  await promisify(execFile)("/opt/homebrew/bin/docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10000 });
  report.checks.docker = { reachable: true };
} catch { report.checks.docker = { reachable: false }; }
report.checks.ocrTcp = await tcp("192.168.0.6", 8081);
try {
  const response = await fetch("http://192.168.0.6:8081/health", { signal: AbortSignal.timeout(8000), redirect: "error" });
  report.checks.ocrHealth = { status: response.status, ok: response.ok };
  await response.body?.cancel();
} catch (e) { report.checks.ocrHealth = { ok: false, type: e?.name ?? "Error", code: e?.cause?.code ?? null }; }
const tls = { serverNameOverride: deployment.tlsServerName,
  serverRootCACertificate: await readFile(join(root, "ca.pem")),
  clientCertPair: { crt: await readFile(join(root, "mac-worker.pem")), key: await readFile(join(root, "mac-worker-key.pem")) } };
let client, native;
try {
  client = await Connection.connect({ address: deployment.address, tls, connectTimeout: "15 seconds" });
  const ns = await client.withDeadline(Date.now() + 5000, () => client.workflowService.describeNamespace({ namespace: deployment.namespace }));
  report.checks.temporalClient = { connected: true, namespace: ns.namespaceInfo?.name };
  native = await NativeConnection.connect({ address: deployment.address, tls });
  report.checks.temporalNative = { connected: true };
} catch (e) {
  report.checks.temporalFailure = { type: e?.name ?? "Error", code: typeof e?.code === "number" ? e.code : null };
} finally { await native?.close(); await client?.close(); }
const networkReady = networkMode === "default-clash"
  ? report.checks.defaultClashListeners.every(l => l.status === "reachable")
  : ["browser", "privateProxy", "privateProxyControl"].every(k => report.checks[k] === "reachable");
report.ready = networkReady && report.checks.docker.reachable && report.checks.ocrHealth.ok &&
  report.checks.temporalClient?.connected === true && report.checks.temporalNative?.connected === true &&
  ["r2Config", "codexAuth"].every(k => report.checks[k]?.regular && report.checks[k]?.private);
await writeFile(join(root, reportName), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
