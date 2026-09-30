// Deliberate legacy-service test only. Does NOT bypass the V3 production adapter's address policy.
// 1 single request, then (only if successful) 4 concurrent requests. No retry, redirect, DB or R2.
import { request } from "node:http";
import { readFile, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

const endpoint = "http://192.168.0.6:8081/ocr?min_score=0.3";
const [phase, root] = process.argv.slice(2);
if (!["single", "parallel"].includes(phase) || !root || !isAbsolute(root)) throw Error("Explicit phase and absolute evidence root required");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function save(name, data) {
  const file = await open(join(root, name), "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
}
const samples = JSON.parse(await readFile(join(root, "samples.json"), "utf8"));
if (JSON.stringify(samples.map(s => [s.label, s.amount, s.filename])) !== JSON.stringify([
  ["ALPHA",101,"ALPHA.png"],["BRAVO",202,"BRAVO.png"],["CHARLIE",303,"CHARLIE.png"],["DELTA",404,"DELTA.png"],["ECHO",505,"ECHO.png"]
])) throw Error("Only the five declared synthetic samples are allowed");
if (phase === "parallel" && !JSON.parse(await readFile(join(root, "single-report.json"), "utf8")).success) throw Error("Single request must pass before concurrency test");
const chosen = phase === "single" ? samples.slice(0, 1) : samples.slice(1);
const prepared = await Promise.all(chosen.map(async s => {
  const bytes = await readFile(join(root, s.filename));
  if (bytes.length !== s.byteSize || sha(bytes) !== s.sha256 || bytes.length > 1024 * 1024) throw Error("Sample integrity mismatch");
  return { ...s, bytes };
}));
// A crash/unknown outcome leaves this marker; rerunning the same phase cannot send again.
await save(`${phase}-intent.json`, JSON.stringify({ endpoint, phase, createdAt: new Date().toISOString(), maxRequests: chosen.length,
  samples: chosen.map(({label, sha256}) => ({ label, sha256 })), noRetry: true }, null, 2));
let active = 0, peak = 0;
const base = performance.now();
async function recognize(sample) {
  const startedAt = new Date().toISOString(), startOffsetMs = performance.now() - base;
  active++; peak = Math.max(peak, active);
  const boundary = `ocr-probe-${randomUUID()}`;
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sample.filename}"\r\nContent-Type: image/png\r\n\r\n`), sample.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request(endpoint, { method: "POST", agent: false, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length, "Accept": "application/json" } });
      const timer = setTimeout(() => req.destroy(Error("TIMEOUT_NO_RETRY")), 45000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => reject(Error("TRANSPORT_UNKNOWN_NO_RETRY")));
      req.on("response", res => {
        const chunks = []; let size = 0;
        res.on("data", chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) res.destroy(Error("OUTPUT_LIMIT")); else chunks.push(chunk); });
        res.on("error", () => reject(Error("RESPONSE_UNKNOWN_NO_RETRY")));
        res.on("end", () => res.complete ? resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }) : reject(Error("INCOMPLETE_NO_RETRY")));
      });
      req.end(body);
    });
    await save(`${sample.label}-response.json`, response.bytes);
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes));
    const text = typeof data.text === "string" ? data.text : "";
    const normalized = text.toUpperCase().replace(/\s+/g, " ");
    const markerMatched = normalized.includes(`SAMPLE ${sample.label}`), amountMatched = normalized.includes(`VITAMIN C ${sample.amount} MG`);
    const foreignMarkers = samples.filter(s => s.label !== sample.label && normalized.includes(`SAMPLE ${s.label}`)).map(s => s.label);
    const result = { label: sample.label, requestSha256: sample.sha256, status: response.status, startedAt, startOffsetMs,
      endOffsetMs: performance.now() - base, clientDurationMs: performance.now() - base - startOffsetMs,
      requestId: response.headers["x-ocr-request-id"] ?? null, gatewayMs: response.headers["x-ocr-gateway-ms"] ?? null,
      responseSha256: sha(response.bytes), responseByteSize: response.bytes.length,
      responseKeys: Object.keys(data), detector: data.detector ?? null, recognizer: data.recognizer ?? null, serverElapsedMs: data.elapsed_ms ?? null,
      serverTiming: { queueWaitMs: data.queue_wait_ms ?? null, predictMs: data.predict_ms ?? null, postprocessMs: data.postprocess_ms ?? null,
        httpTotalMs: data.http_total_ms ?? null, gatewayQueueWaitMs: data.gateway_queue_wait_ms ?? null, gatewayTotalMs: data.gateway_total_ms ?? null },
      backendPort: data.backend_port ?? null, workerPid: data.worker_pid ?? null, gatewayAttempts: data.gateway_attempts ?? null,
      text, lines: Array.isArray(data.lines) ? data.lines.length : null,
      linesHaveScores: Array.isArray(data.lines) && data.lines.every(l => typeof l.score === "number"),
      linesHavePolygons: Array.isArray(data.lines) && data.lines.every(l => Array.isArray(l.polygon)),
      markerMatched, amountMatched, foreignMarkers,
      success: response.status === 200 && markerMatched && amountMatched && foreignMarkers.length === 0 && Array.isArray(data.lines) };
    await save(`${sample.label}-result.json`, JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const result = { label: sample.label, startedAt, startOffsetMs, endOffsetMs: performance.now() - base, success: false,
      outcome: "unverified_no_retry", error: ["TRANSPORT_UNKNOWN_NO_RETRY", "RESPONSE_UNKNOWN_NO_RETRY", "INCOMPLETE_NO_RETRY"].includes(error.message) ? error.message : "RESPONSE_OR_EVIDENCE_INVALID" };
    await save(`${sample.label}-failure.json`, JSON.stringify(result, null, 2)); return result;
  } finally { active--; }
}
const results = await Promise.all(prepared.map(recognize));
const report = { phase, endpoint, synthetic: true, requestCount: chosen.length, peakClientInFlight: peak,
  wallMs: performance.now() - base, success: results.every(r => r.success), results,
  limits: "Client concurrency only; not proof of backend parallel compute or maximum capacity. No retries; no DB/R2/Temporal mutations." };
await save(`${phase}-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
