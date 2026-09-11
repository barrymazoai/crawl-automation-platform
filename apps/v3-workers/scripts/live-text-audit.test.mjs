import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reserveExecution, installTextAudit } from "./live-text-audit.mjs";
import https from "node:https";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
test("only one business execution across workers; read-only denies new execution", () => {
  const root = mkdtempSync(join(tmpdir(), "text-budget-")); reserveExecution(root);
  assert.throws(() => reserveExecution(root), /EEXIST/);
  writeFileSync(join(root, "read-only"), ""); assert.throws(() => reserveExecution(root), /READ_ONLY/);
});
test("invalid scope rejected before installing hooks", () => {
  assert.throws(() => installTextAudit({ root: "/tmp", executable: "/codex", r2Origin: "https://example.com", pathPrefix: "/" }), /CONFIG/);
});
for (const scope of ["text", "vision"]) test(`${scope} audit forwards original IO, allows internal events, denies second turn and recovery PUT`, () => {
  const root = mkdtempSync(join(tmpdir(), "text-audit-")), originalRequest = https.request, originalSpawn = childProcess.spawn;
  const requests = [], messages = [], stdout = new EventEmitter();
  https.request = (...args) => { requests.push(args); return new EventEmitter(); };
  childProcess.spawn = () => ({ pid: 42, stdout, stdin: { write: chunk => { messages.push(chunk); return true; } } });
  try {
    const host = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", path = `/supply-smart-test/${scope}-live/abc/`;
    installTextAudit({ root, executable: "/codex", r2Origin: `https://${host}`, pathPrefix: path });
    const child = childProcess.spawn("/codex", []), turn = JSON.stringify({ method: "turn/start", params: { threadId: "one" } }) + "\n";
    child.stdin.write(turn);
    for (let n = 0; n < 4; n++) stdout.emit("data", JSON.stringify({ method: "error", params: { willRetry: true } }) + "\n");
    assert.equal(messages.length, 1); assert.throws(() => child.stdin.write(turn), /DENIED/);
    const options = { hostname: host, path: path + "result", method: "PUT" }; https.request(options);
    assert.equal(requests[0][0], options);
    writeFileSync(join(root, "read-only"), ""); assert.throws(() => https.request(options), /DENIED/);
    https.request({ ...options, method: "GET" }); assert.equal(requests.length, 2);
    assert.throws(() => https.request({ ...options, method: "GET", path: "/other" }), /DENIED/);
  } finally { https.request = originalRequest; childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
});
