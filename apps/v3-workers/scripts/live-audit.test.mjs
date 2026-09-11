import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reserveOcr, installAudit } from "./live-audit.mjs";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
test("budget admits at most three calls even after module-level reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-budget-"));
  assert.deepEqual([reserveOcr(root), reserveOcr(root), reserveOcr(root)], [1, 2, 3]);
  assert.throws(() => reserveOcr(root), /BUDGET_EXHAUSTED/);
  assert.equal(readdirSync(root).length, 3);
});
test("read-only phase refuses OCR without consuming a slot", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-budget-")); writeFileSync(join(root, "read-only"), "");
  assert.throws(() => reserveOcr(root), /READ_ONLY/); assert.equal(readdirSync(root).length, 1);
});
test("wrong acceptance scope cannot install an outbound wrapper", () => {
  assert.throws(() => installAudit({ root: "/tmp", r2Origin: "https://example.com", ocrEndpoint: "http://example.com", pathPrefix: "/" }), /CONFIG/);
});
test("audit preserves request arguments, records calls and refuses new work in read-only phase", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-audit-")), originalHttp = http.request, originalHttps = https.request;
  const calls = [], endpoint = new URL("http://192.168.0.6:8081/ocr?min_score=0.3");
  const fakeRequest = (...args) => { calls.push(args); return new EventEmitter(); };
  http.request = fakeRequest; https.request = fakeRequest;
  try {
    installAudit({ root, ocrEndpoint: endpoint.href, r2Origin: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
      pathPrefix: "/supply-smart-test/ocr-live/example/" });
    const options = { method: "POST" }, request = http.request(endpoint, options);
    assert.equal(calls[0][0], endpoint); assert.equal(calls[0][1], options);
    request.emit("response", { statusCode: 200 }); request.emit("close");
    const get = { host: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", method: "GET", path: "/supply-smart-test/ocr-live/example/a" };
    https.request(get).emit("close"); assert.equal(calls[1][0], get);
    writeFileSync(join(root, "read-only"), "");
    assert.throws(() => http.request(endpoint, options), /DENIED/);
    assert.throws(() => https.request({ ...get, method: "PUT" }), /DENIED/);
    assert.throws(() => https.request({ ...get, path: "/another-scope/a" }), /DENIED/);
    https.request(get).emit("close"); assert.equal(calls.length, 3);
  } finally { http.request = originalHttp; https.request = originalHttps; syncBuiltinESMExports(); }
});
