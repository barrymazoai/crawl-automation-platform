import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createR2Objects } from "../../v3-artifacts/dist/index.js";
import { loadConfig } from "../../v3-artifacts/scripts/live-config.mjs";
import { TextLocalStore } from "../../v3-text/dist/index.js";
import { AcquireGncModule, GncCaptureEvidence, GncAdapter, gncKeys } from "../dist/index.js";

// Real R2 only; synthetic page read. No site, model, database, lifecycle or DELETE operation.
const [mode, configPath, statePath] = process.argv.slice(2);
const signal = () => AbortSignal.timeout(30000);
async function main() {
  if (!["--run", "--child-read", "--inspect-existing"].includes(mode)) throw Error("CONFIG_MODE");
  const config = await loadConfig(configPath);
  if (config.bucket !== "supply-smart-test") throw Error("CONFIG_TEST_BUCKET_REQUIRED");
  if (mode === "--inspect-existing") {
    // Recovery of this harness, not a new acquisition: use an explicit retained local completion.
    const record = JSON.parse(await readFile(statePath, "utf8"));
    const prefix = `crawlv3-acceptance/gnc-${record.input.capture.operationId.replace(/^op-/, "")}`;
    if (!/^crawlv3-acceptance\/gnc-[a-f0-9-]{36}$/.test(prefix)) throw Error("CONFIG_PREFIX");
    const root = await mkdtemp(join(tmpdir(), "v3-gnc-r2-inspect-")), local = await TextLocalStore.open(root);
    console.log(JSON.stringify({ phase: "read-only-recovery", root, prefix }));
    const remote = createR2Objects({ endpoint: config.endpoint, bucket: config.bucket, prefix, timeoutMs: 15000 }, config.credentials);
    let reads = 0, writes = 0;
    const store = { read: (...args) => { reads++; return remote.store.read(...args); }, create: async () => { writes++; throw Error("READ_ONLY"); } };
    try {
      const evidence = new GncCaptureEvidence({ local, remote: store, reviews: { read: async () => null, append: async () => { throw Error("READ_ONLY"); } } });
      const confirmed = await evidence.inspect(record.input, AbortSignal.timeout(60000)); assert.deepEqual(confirmed, record);
      const result = evidence.receipt(confirmed), keys = gncKeys(record.input), objects = [];
      const all = [...Object.values(keys), ...[keys.source, keys.received, keys.evidence, keys.completion].map(k => `gnc-publications/${createHash("sha256").update(k).digest("hex")}.json`)];
      for (const key of all) { const b = await store.read(key, 8388608, signal()); assert.ok(b); objects.push({ key, byteSize: b.length }); }
      await local.create("run/state.json", Buffer.from(JSON.stringify({ input: record.input, prefix, result })), "application/json", signal());
      const run = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--child-read", configPath, join(root, "run/state.json")], { timeout: 90000 });
      const replacement = JSON.parse(run.stdout.trim()); assert.equal(writes, 0);
      const report = { status: "passed-read-only-recovery", root, bucket: config.bucket, prefix, originalHarnessFailed: true, reads, writes, replacement,
        objects, bytesRetained: objects.reduce((n, o) => n + o.byteSize, 0), realSiteRequests: 0, models: 0, deletes: 0,
        note: "Original acceptance did not finish its report; existing complete evidence verified without new upload or capture. No production DB/Worker or lifecycle changes." };
      await local.create("run/report.json", Buffer.from(JSON.stringify(report, null, 2)), "application/json", signal()); console.log(JSON.stringify(report));
    } finally { remote.close(); }
    return;
  }
  const child = mode === "--child-read";
  const state = child ? JSON.parse(await readFile(statePath, "utf8")) : null;
  const id = randomUUID(), prefix = child ? state.prefix : `crawlv3-acceptance/gnc-${id}`;
  if (!/^crawlv3-acceptance\/gnc-[a-f0-9-]{36}$/.test(prefix)) throw Error("CONFIG_PREFIX");
  const root = await mkdtemp(join(tmpdir(), "v3-gnc-r2-")), local = await TextLocalStore.open(join(root, "local"));
  if (!child) console.log(JSON.stringify({ phase: "start", root, bucket: config.bucket, prefix }));
  const remote = createR2Objects({ endpoint: config.endpoint, bucket: config.bucket, prefix, timeoutMs: 15000 }, config.credentials);
  let reads = 0, writes = 0, sourceReads = 0;
  const objects = new Map(); let lostCompletionAck = false;
  const store = {
    read: (...args) => { reads++; return remote.store.read(...args); },
    create: async (key, bytes, media, s) => {
      writes++; const value = await remote.store.create(key, bytes, media, s);
      objects.set(key, bytes.length);
      if (!child && key.endsWith("/completion.json")) { lostCompletionAck = true; throw Error("synthetic lost acknowledgement after real PUT"); }
      return value;
    },
  };
  const input = child ? state.input : { schemaVersion: 1, implementationVersion: "gnc-acquire/1",
    owner: { schemaVersion: 1, requestId: `req-${id}`, observationId: `obs-${id}`, brandId: "synthetic-brand", sourceId: "synthetic-gnc", listingId: `listing-${id}`, variantId: null },
    capture: { kind: "product", requestId: `req-${id}`, operationId: `op-${id}`, brandId: "synthetic-brand", sourceId: "synthetic-gnc", binding: { sessionId: "synthetic-session", egressId: "fixture/1" }, url: "https://www.gnc.com/123456.html", sku: "123456" },
    network: { routeId: "synthetic-host", version: "1", egressId: "fixture/1", mode: "host", managed: false } };
  const html = '<script type="application/ld+json">{"@type":"Product","sku":"123456","name":"Synthetic R2 Vitamin"}</script><div id="productIngredientsAccordionContent"><table><tr><td>Vitamin C</td><td>10 mg</td></tr></table>Other ingredients: cellulose</div>';
  // Local review repository only for this harness; production PostgreSQL binding is not tested here.
  const reviews = { read: async id => { const b = await local.read(`reviews/${id}.json`, 65536, signal()); return b ? JSON.parse(Buffer.from(b).toString()) : null; },
    append: async record => local.create(`reviews/${record.reviewId}.json`, Buffer.from(JSON.stringify(record)), "application/json", signal()) };
  const adapter = new GncAdapter({ read: async c => {
    sourceReads++; if (child) throw Error("CHILD_CANNOT_CRAWL");
    return { operationId: c.operationId, requestedUrl: c.url, finalUrl: c.url, binding: c.binding, status: 200, contentType: "text/html", bytes: Buffer.from(html), network: input.network };
  } });
  try {
    const evidence = new GncCaptureEvidence({ local, remote: store, reviews });
    const result = await new AcquireGncModule(evidence, adapter).run(input, AbortSignal.timeout(60000));
    if (!child) console.log(JSON.stringify({ phase: "captured", status: result.status, reads, writes, sourceReads, objectCount: objects.size, lostCompletionAck }));
    assert.equal(result.status, "durable");
    if (child) {
      assert.deepEqual(result, state.result); assert.equal(sourceReads, 0); assert.equal(writes, 0);
      console.log(JSON.stringify({ pid: process.pid, status: "passed", reads, writes, sourceReads, emptyCache: true })); return;
    }
    assert.equal(sourceReads, 1); assert.equal(writes, 9); assert.equal(objects.size, 9); assert.equal(lostCompletionAck, true);
    assert.equal(Buffer.from(await store.read(gncKeys(input).source, 2097152, signal())).toString(), html);
    const stateStore = await TextLocalStore.open(root);
    await stateStore.create("run/state.json", Buffer.from(JSON.stringify({ input, prefix, result })), "application/json", signal());
    const childRun = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--child-read", configPath, join(root, "run/state.json")], { timeout: 60000 });
    const cold = JSON.parse(childRun.stdout.trim());
    const report = { status: "passed", bucket: config.bucket, prefix, root, syntheticPage: true, realSiteRequests: 0, models: 0, deletes: 0,
      reads, writes, sourceReads, lostCompletionAck, objects: [...objects].map(([key, byteSize]) => ({ key, byteSize })),
      bytesRetained: [...objects.values()].reduce((a, b) => a + b, 0), replacement: cold,
      retentionPolicy: "not inspected or changed; objects retained by this harness", productionWorker: false, productionDatabase: false };
    await stateStore.create("run/report.json", Buffer.from(JSON.stringify(report, null, 2)), "application/json", signal());
    console.log(JSON.stringify(report));
  } finally { remote.close(); }
}
main().catch(error => { console.error(JSON.stringify({ status: "GNC_R2_ACCEPTANCE_FAILED", code: /^[A-Z_.]+$/.test(String(error?.code ?? "")) ? error.code : "REDACTED", name: /^[A-Za-z]+$/.test(String(error?.name)) ? error.name : "Error",
  issues: Array.isArray(error?.issues) ? error.issues.map(i => ({ path: i.path, code: i.code })) : undefined })); process.exitCode = 1; });
