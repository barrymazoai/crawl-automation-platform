// Opt-in acceptance instrumentation only: no endpoint rewriting, fake response or TLS bypass.
import http from "node:http";
import https from "node:https";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

export function reserveOcr(root) {
  if (existsSync(join(root, "read-only"))) throw Error("LIVE_READ_ONLY");
  for (let n = 1; n <= 3; n++) {
    try { writeFileSync(join(root, `ocr-slot-${n}.json`), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 }); return n; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  throw Error("LIVE_OCR_BUDGET_EXHAUSTED");
}
export function installAudit(config) {
  if (!isAbsolute(config.root) || !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(config.r2Origin) ||
      config.ocrEndpoint !== "http://192.168.0.6:8081/ocr?min_score=0.3" || !config.pathPrefix.startsWith("/supply-smart-test/ocr-live/")) throw Error("LIVE_AUDIT_CONFIG");
  const record = (data) => writeFileSync(join(config.root, `event-${randomUUID()}.json`), JSON.stringify({ ...data, pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
  const wrap = (original, isOcr) => function (...args) {
    const url = args[0] instanceof URL ? args[0] : null;
    const options = url ? args[1] : args[0];
    const method = options?.method ?? "GET";
    const host = url?.hostname ?? options?.hostname ?? options?.host;
    const path = url ? url.pathname + url.search : options?.path;
    try {
      if (isOcr) {
        if (url?.href !== config.ocrEndpoint || method !== "POST") throw Error("LIVE_HTTP_TARGET_DENIED");
        reserveOcr(config.root);
      } else {
        if (host !== new URL(config.r2Origin).hostname || !["GET", "PUT"].includes(method) || !path?.startsWith(config.pathPrefix)) throw Error("LIVE_S3_TARGET_DENIED");
        if (method === "PUT" && existsSync(join(config.root, "read-only"))) throw Error("LIVE_READ_ONLY");
      }
    } catch { record({ kind: "denied", service: isOcr ? "ocr" : "r2", method }); throw Error("LIVE_REQUEST_DENIED"); }
    const id = randomUUID(); record({ kind: "start", id, service: isOcr ? "ocr" : "r2", method, path: path.split("?")[0] });
    const request = original.apply(this, args);
    let status = null;
    request.on("response", res => { status = res.statusCode; });
    request.on("close", () => record({ kind: "close", id, status }));
    return request;
  };
  http.request = wrap(http.request, true); https.request = wrap(https.request, false);
  syncBuiltinESMExports();
}
if (process.env.V3_LIVE_AUDIT_ENABLED === "true") installAudit(JSON.parse(readFileSync(process.env.V3_LIVE_AUDIT_CONFIG, "utf8")));
