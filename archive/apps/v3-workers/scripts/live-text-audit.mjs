// Acceptance-only observation/guard. Never rewrites endpoints, responses or TLS.
import https from "node:https";
import childProcess from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

export function reserveExecution(root) {
  if (existsSync(join(root, "read-only"))) throw Error("LIVE_READ_ONLY");
  writeFileSync(join(root, "business-execution.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
}
export function installCodexAudit(config) {
  if (!isAbsolute(config.root) || !isAbsolute(config.executable) || !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(config.r2Origin) ||
      !/^\/supply-smart-test\/(?:text|vision)-live\/[a-f0-9-]+\/$/.test(config.pathPrefix)) throw Error("LIVE_AUDIT_CONFIG");
  const record = data => writeFileSync(join(config.root, `event-${randomUUID()}.json`), JSON.stringify({ ...data, pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
  const originalRequest = https.request, originalSpawn = childProcess.spawn;
  https.request = function (...args) {
    const url = args[0] instanceof URL ? args[0] : null, options = url ? args[1] : args[0];
    const method = options?.method ?? "GET", host = url?.hostname ?? options?.hostname ?? options?.host, path = url?.pathname ?? options?.path;
    if (host !== new URL(config.r2Origin).hostname || !["GET", "PUT"].includes(method) || !path?.startsWith(config.pathPrefix) ||
        (method === "PUT" && existsSync(join(config.root, "read-only")))) {
      record({ kind: "denied", service: "r2", method }); throw Error("LIVE_REQUEST_DENIED");
    }
    const id = randomUUID(); record({ kind: "start", id, service: "r2", method, path: path.split("?")[0] });
    const request = originalRequest.apply(this, args); let status = null;
    request.on("response", response => { status = response.statusCode; });
    request.on("close", () => record({ kind: "close", id, status })); return request;
  };
  childProcess.spawn = function (executable, args, options) {
    const child = originalSpawn.call(this, executable, args, options);
    if (executable !== config.executable) return child;
    record({ kind: "codex-process", childPid: child.pid });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = function (chunk, ...rest) {
      // CodexRpc sends exactly one complete JSON line per write; only business turn/start is gated.
      const message = JSON.parse(String(chunk));
      if (message.method === "turn/start") {
        try { reserveExecution(config.root); }
        catch { record({ kind: "denied", service: "codex-business" }); throw Error("LIVE_EXECUTION_DENIED"); }
        record({ kind: "business-turn", childPid: child.pid, threadId: message.params.threadId });
      }
      return write(chunk, ...rest);
    };
    let buffer = "";
    child.stdout.on("data", chunk => {
      buffer += String(chunk); let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const m = JSON.parse(line);
          if (m.method === "turn/completed") record({ kind: "turn-completed", childPid: child.pid, status: m.params?.turn?.status });
        } catch { /* protocol parsing belongs to the real Provider */ }
      }
    }); return child;
  };
  syncBuiltinESMExports();
}
export const installTextAudit = installCodexAudit;
if (process.env.V3_TEXT_AUDIT_ENABLED === "true" && process.env.V3_VISION_AUDIT_ENABLED === "true") throw Error("LIVE_AUDIT_AMBIGUOUS");
if (process.env.V3_TEXT_AUDIT_ENABLED === "true") installCodexAudit(JSON.parse(readFileSync(process.env.V3_TEXT_AUDIT_CONFIG, "utf8")));
if (process.env.V3_VISION_AUDIT_ENABLED === "true") installCodexAudit(JSON.parse(readFileSync(process.env.V3_VISION_AUDIT_CONFIG, "utf8")));
