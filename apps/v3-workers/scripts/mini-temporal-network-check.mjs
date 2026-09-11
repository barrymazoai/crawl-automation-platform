// Scoped read-only diagnostics; no Clash rule or selector changes.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { hostname } from "node:os";
import tls from "node:tls";
import http from "node:http";
const [root, reportName = "network-check.json"] = process.argv.slice(2);
if (!root?.startsWith("/Users/barry/apps/crawlv3-gnc-e2e.") || !/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("MINI_ONLY");
if (!/^network-check(?:-[a-z0-9-]+)?\.json$/.test(reportName)) throw Error("INVALID_REPORT_NAME");
const require = createRequire("/Users/barry/apps/crawl-platform-v4-parallel/apps/backend/package.json");
const cfg = require("yaml").parse(await readFile("/Users/barry/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml", "utf8"));
const d = JSON.parse(await readFile(join(root, "deployment.json"), "utf8"));
const options = { servername: d.tlsServerName, ca: await readFile(join(root, "ca.pem")), cert: await readFile(join(root, "mac-worker.pem")),
  key: await readFile(join(root, "mac-worker-key.pem")), ALPNProtocols: ["h2"], rejectUnauthorized: true };
// Query the active GUI/TUN core, not a stale independently running TCP controller.
const socketPath = cfg["external-controller-unix"];
if (socketPath !== "/tmp/verge/verge-mihomo.sock") throw Error("UNEXPECTED_CONTROL_SOCKET");
const api = path => new Promise((resolve, reject) => {
  const request = http.get({ socketPath, path, headers: { Authorization: `Bearer ${cfg.secret}` } }, response => {
    let bytes = ""; response.on("data", chunk => { bytes += chunk; });
    response.on("end", () => {
      if (response.statusCode !== 200) return reject(Error(`CONTROL_${response.statusCode}`));
      try { resolve(JSON.parse(bytes)); } catch { reject(Error("CONTROL_RESPONSE_INVALID")); }
    });
  });
  request.setTimeout(5000, () => request.destroy(Error("CONTROL_TIMEOUT")));
  request.on("error", reject);
});
const rules = (await api("/rules")).rules;
const proxies = (await api("/proxies")).proxies;
const report = { at: new Date().toISOString(), controller: "active-unix-socket", configuredRules: rules.filter(r => String(r.payload).includes("rlwy.net") || r.type === "Match"),
  aiGroup: Object.entries(proxies).filter(([k]) => k.includes("AI/X")).map(([name, p]) => ({ name, type: p.type, now: p.now })), tests: [], changes: 0 };
async function check(mode) {
  const [host, port] = d.address.split(":");
  return new Promise(resolve => {
    let socket, request, done = false, tcpConnected = false, tunnelStatus = null;
    const started = Date.now();
    const finish = outcome => { if (done) return; done = true; clearTimeout(timer); socket?.destroy(); request?.destroy(); resolve({ mode, tcpConnected, tunnelStatus, elapsedMs: Date.now() - started, ...outcome }); };
    const timer = setTimeout(() => finish({ status: "timeout" }), 12000);
    const secure = raw => {
      socket = tls.connect({ ...options, ...(raw ? { socket: raw } : { host, port: Number(port) }) });
      if (raw) tcpConnected = true;
      else socket.once("connect", () => { tcpConnected = true; });
      socket.once("secureConnect", () => finish({ status: "tls-connected", authorized: socket.authorized, alpn: socket.alpnProtocol }));
      socket.once("error", e => finish({ status: "error", code: e.code ?? "TLS_ERROR" }));
    };
    if (mode === "direct-sdk-route") secure();
    else {
      request = http.request({ host: "127.0.0.1", port: cfg["mixed-port"], method: "CONNECT", path: d.address });
      request.once("connect", (response, raw, head) => {
        tunnelStatus = response.statusCode;
        if (response.statusCode !== 200) { raw.destroy(); return finish({ status: "connect-rejected", code: response.statusCode }); }
        if (head.length) raw.unshift(head); secure(raw);
      });
      request.once("error", e => finish({ status: "error", code: e.code ?? "CONNECT_ERROR" })); request.end();
    }
  });
}
for (const mode of ["direct-sdk-route", "explicit-existing-clash"]) report.tests.push(await check(mode));
await writeFile(join(root, reportName), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
