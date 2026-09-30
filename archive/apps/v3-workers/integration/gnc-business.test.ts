import { createServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { GNC_QUEUES, GNC_PRODUCT_QUEUES, TextOutputSchema, type GncAcquireInput, type GncProductInput, type FileAcquireInput, type VisionTask } from "@crawl-automation/v3-contracts";
import { gncKeys, GncProductPlans, GncCaptureEvidence, gncProductKey } from "@crawl-automation/v3-channels";
import { FileCopies, ArtifactResolver, verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { FileEvidence, PrepareImageOcr, PageEvidence, PreparePageModule, PreparePageText } from "@crawl-automation/v3-acquisition";
import { TextEvidence, TextHandoff, TextModule, ResolveTextReceipt, PostgresTextRegistry } from "@crawl-automation/v3-text";
import { FileCompletionJournal, PostgresResultRegistry, OcrResultHandoff } from "@crawl-automation/v3-results";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { OcrFileModule, OcrIntents } from "@crawl-automation/v3-ocr";
import { RegisteredOcrEvidence, VisionModule, VisionHandoff, PostgresVisionRegistry, KeywordPublication } from "@crawl-automation/v3-vision";
import { SavedSourceEvidence, ProductEvidenceAssembly, CollectMixedProduct, PostgresMixedCollectedProducts, ResolveOcrReceipt } from "@crawl-automation/v3-product";
import { MemoryObjects, signal } from "../../../packages/v3-results/src/testing.fixture.js";
import { fixture as textFixture } from "../../../packages/v3-text/src/testing.fixture.js";
import { candidate as visionCandidate } from "../../../packages/v3-vision/src/testing.fixture.js";
import { png } from "../../../packages/v3-acquisition/src/testing.fixture.js";
import { startTestDatabase } from "../../v3-api/integration/postgres.js";

const exec = promisify(execFile), entry = resolve("dist/gnc/gnc-worker.js"), wfEntry = resolve("dist/gnc/gnc-workflow-worker.js");
const r2Host = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", bucket = "synthetic-only", prefix = `gnc-worker/${randomUUID()}`;
const objects = new Map<string, Buffer>(), pages = new Map<string, string>(), children: ChildProcess[] = [];
type Role = { role: string; capability: string; compatibility: string; buildId: string };
let root: string, port: number, reviewUrl: string, roles: Role[], sourceReads = 0, puts = 0;
let temporal: TestWorkflowEnvironment, db: Awaited<ReturnType<typeof startTestDatabase>>, server: ReturnType<typeof createServer>;
let productChild: ChildProcess;
let proxy: ReturnType<typeof httpServer>, proxyPort: number, downloads = 0;
const sockets = new Set<Socket>(), tunnels: string[] = [], imageRequests: { path: string; cookie: string | undefined; proxyAuth: string | undefined }[] = [];
const reports: Record<string, unknown> = {};
const pathFor = (key: string) => `/${bucket}/${prefix}/${key}`;
const network = { routeId: "fixture-direct", version: "1", egressId: "direct/1", mode: "direct", managed: true } as const;
function task(id: string, sku = "123456"): GncAcquireInput {
  return { schemaVersion: 1, implementationVersion: "gnc-acquire/1",
    owner: { schemaVersion: 1, requestId: id, observationId: `obs-${id}`, brandId: "brand", sourceId: "source", listingId: `listing-${sku}`, variantId: null },
    capture: { kind: "product", requestId: id, operationId: id, brandId: "brand", sourceId: "source", binding: { sessionId: "session", egressId: "direct/1" }, url: `https://www.gnc.com/${sku}.html`, sku }, network };
}
const productA = task("product-a"), productB = task("product-b", "123457"), broken = task("broken", "123458");
const catalog: GncAcquireInput = { ...task("catalog"), capture: { ...task("catalog").capture, kind: "catalog-page", url: "https://www.gnc.com/brands/example/" } as GncAcquireInput["capture"] };
delete (catalog.capture as unknown as Record<string, unknown>).sku;
const page = (sku: string) => `<script type="application/ld+json">{"@type":"Product","sku":"${sku}","name":"Vitamin"}</script><div id="productIngredientsAccordionContent"><table><tr><td>Vitamin C</td><td>10 mg</td></tr></table>Other ingredients: cellulose</div>`;
async function settings(host: string, role: Role, tasks: GncAcquireInput[] = [], fileInputs: GncProductInput[] = []) {
  const path = join(root, `${host}-private.json`);
  await writeFile(path, JSON.stringify({ role: role.role, journalRoot: join(root, host, "journal"),
    r2: { endpoint: `https://${r2Host}`, bucket, prefix, timeoutMs: 2000 },
    r2Credentials: { accessKeyId: "synthetic-key", secretAccessKey: "synthetic-secret" },
    reviewDatabase: { connectionString: reviewUrl, tls: false },
    ...(["gnc-product", "gnc-catalog"].includes(role.role) ? { network: tasks[0]?.network ?? network,
      browser: { endpoint: "http://127.0.0.1:19876", instanceId: "fixture", sessionId: "session" },
      grants: tasks.map(task => ({ task, expiresAt: "2099-01-01T00:00:00Z" })) } : {}),
    ...(role.role === "gnc-file" ? { cacheRoot: join(root, host, "cache"), network: fileInputs[0]!.task.network,
      proxyUrl: `http://fixture:secret@127.0.0.1:${proxyPort}`, fileGrants: fileInputs.map(input => ({ input,
        allowedOrigins: ["https://www.gnc.com"], expiresAt: "2099-01-01T00:00:00Z", headersByOrigin: { "https://www.gnc.com": { cookie: "image-only" } } })) } : {}),
  }), { mode: 0o600 }); return path;
}
async function runtime(host: string, role: Role) {
  const path = join(root, `${host}-runtime.json`);
  await writeFile(path, JSON.stringify({ role: role.role, capability: role.capability, compatibility: role.compatibility, contractVersion: 1,
    expectedBuildId: role.buildId, hostId: host, namespace: "default", address: temporal.address, transport: { mode: "local" },
    concurrency: role.role.endsWith("workflow") || role.role === "gnc-file" ? 2 : 1, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 }); return path;
}
async function launch(host: string, name: string, tasks: GncAcquireInput[] = [], denySource = false, fileInputs: GncProductInput[] = []) {
  const role = roles.find(r => r.role === name)!, workflow = name.endsWith("workflow");
  const child = spawn(process.execPath, [...(!workflow ? ["--import", resolve("integration/fixtures/gnc-loopback.mjs")] : []), workflow ? wfEntry : entry], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port), V3_TEST_DENY_SOURCE: String(denySource),
      V3_GNC_LIVE_ENABLED: "true", V3_GNC_CONFIG: workflow ? "" : await settings(host, role, tasks, fileInputs),
      V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: await runtime(host, role) }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); }); child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  ((reports.processes ??= []) as unknown[]).push({ host, role: name, pid: child.pid, buildId: role.buildId });
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try { await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 10000 }); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
const start = (task: GncAcquireInput) => temporal.client.workflow.start("GncCaptureWorkflow", { taskQueue: GNC_QUEUES.workflow, workflowId: `gnc-${randomUUID()}`, args: [{ task }], workflowExecutionTimeout: "2 minutes" });
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v3-gnc-business-"));
  roles = [...JSON.parse((await exec(process.execPath, [entry, "--list"])).stdout), ...JSON.parse((await exec(process.execPath, [wfEntry, "--list"])).stdout)];
  db = await startTestDatabase({ tcp: true });
  const password = randomUUID();
  await db.pool.query(`CREATE ROLE gnc_review LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await db.pool.query("GRANT USAGE ON SCHEMA public TO gnc_review; GRANT SELECT,INSERT ON public.review_record TO gnc_review");
  const url = new URL(db.databaseUrl!); url.username = "gnc_review"; url.password = password; reviewUrl = url.href;
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${r2Host}`,
    "-addext", `subjectAltName=DNS:${r2Host},DNS:www.gnc.com`, "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
  pages.set("/123456.html", page("123456")); pages.set("/123457.html", page("123457")); pages.set("/123458.html", page("999999"));
  pages.set("/brands/example/", '<div class="product-tile"><a href="/123456.html">Vitamin</a></div>');
  server = createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, (req, res) => {
    const key = new URL(req.url!, "https://fixture").pathname;
    if (req.headers.host?.split(":")[0] === "www.gnc.com") {
      if (["/label.png", "/marketing.png"].includes(key)) {
        downloads++; imageRequests.push({ path: key, cookie: req.headers.cookie, proxyAuth: req.headers["proxy-authorization"] });
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length }); res.end(png); return;
      }
      sourceReads++; const data = pages.get(key); res.writeHead(data ? 200 : 404, { "Content-Type": "text/html" }); res.end(data ?? "missing"); return;
    }
    const fail = (status: number, code: string) => { res.writeHead(status, { "Content-Type": "application/xml" }); res.end(`<Error><Code>${code}</Code></Error>`); };
    if (!key.startsWith(`/${bucket}/${prefix}/`) || !req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) return fail(403, "AccessDenied");
    if (req.method === "GET") { const data = objects.get(key); if (!data) return fail(404, "NoSuchKey"); res.writeHead(200, { "Content-Length": data.length }); res.end(data); return; }
    if (req.method !== "PUT" || req.headers["if-none-match"] !== "*") return fail(403, "AccessDenied");
    puts++; const chunks: Buffer[] = []; req.on("data", b => chunks.push(b)); req.on("end", () => {
      if (objects.has(key)) return fail(412, "PreconditionFailed"); objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"fixture"' }); res.end();
    });
  });
  await new Promise<void>((r, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", r); });
  const address = server.address(); if (!address || typeof address === "string") throw Error(); port = address.port;
  const track = (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {}); };
  proxy = httpServer(); proxy.on("connection", track);
  proxy.on("connect", (req, client, head) => {
    if (req.url !== "www.gnc.com:443" || req.headers["proxy-authorization"] !== `Basic ${Buffer.from("fixture:secret").toString("base64")}` || req.headers.cookie) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return;
    }
    tunnels.push(req.url);
    const upstream = connect(port, "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    track(upstream); client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
  });
  await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
  const pa = proxy.address(); if (!pa || typeof pa === "string") throw Error(); proxyPort = pa.port;
  temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
    executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI } : { type: "cached-download", version: "v1.8.3" } } });
});
afterAll(async () => {
  const shutdowns = await Promise.allSettled(children.map(stop));
  if (root && db) await writeFile(join(root, "proof.json"), JSON.stringify({ reports, sourceReads, downloads, proxyTunnels: tunnels.length, puts, objects: objects.size,
    reviews: (await db.pool.query("SELECT review_id,record->'failure' AS failure FROM review_record")).rows,
    realGncCalls: 0, realR2Calls: 0, realModelCalls: 0 }, null, 2), { mode: 0o600 });
  await temporal?.teardown(); await db?.close();
  for (const s of sockets) s.destroy();
  if (proxy) await new Promise<void>(r => proxy.close(() => r()));
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  console.log(`GNC isolated evidence: ${root}; real GNC/R2/model calls: 0`);
  expect(shutdowns.every(s => s.status === "fulfilled")).toBe(true);
  expect(children.every(c => c.exitCode === 0)).toBe(true);
});
it("lists seven distinct business roles without credentials; private config, role and opt-in gates fail closed", async () => {
  expect(roles.map(r => `v3.${r.capability}.v1.${r.compatibility}`).sort()).toEqual([...Object.values(GNC_QUEUES), GNC_PRODUCT_QUEUES.prepare, GNC_PRODUCT_QUEUES.workflow, GNC_PRODUCT_QUEUES.files].sort());
  const role = roles.find(r => r.role === "gnc-receipt")!, path = await settings("startup", role), worker = await runtime("startup", role);
  const valid = JSON.parse(await readFile(path, "utf8"));
  for (const scenario of ["opt-out", "public-file", "wrong-role", "network-on-receipt"] as const) {
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ ...valid, ...(scenario === "wrong-role" ? { role: "gnc-product" } : {}), ...(scenario === "network-on-receipt" ? { network } : {}) }));
    if (scenario === "public-file") await chmod(path, 0o644);
    const result = await exec(process.execPath, [entry], { timeout: 10000, env: { ...process.env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: worker,
      V3_GNC_CONFIG: path, V3_GNC_LIVE_ENABLED: scenario === "opt-out" ? "false" : "true" } }).then(() => ({ code: 0, stderr: "" }), e => ({ code: e.code, stderr: e.stderr as string }));
    expect(result.code).toBe(1); expect(result.stderr).not.toContain("synthetic-secret");
  }
  expect(sourceReads).toBe(0); expect(puts).toBe(0);
});
it("production processes release serial capture slots before receipts start; cold replacement never recrawls", async () => {
  await launch("workflow", "gnc-workflow");
  productChild = await launch("product-a-host", "gnc-product", [productA, productB, broken]);
  await launch("catalog-host", "gnc-catalog", [catalog]);
  const handles = await Promise.all([productA, productB, catalog].map(start));
  await vi.waitFor(async () => {
    for (const h of handles) {
      const events = (await h.fetchHistory()).events ?? [];
      expect(events.filter(e => e.activityTaskCompletedEventAttributes)).toHaveLength(1);
      expect(events.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "resolveGncReceipt")).toBe(true);
      expect((await h.describe()).status.name).toBe("RUNNING");
    }
  }, { timeout: 15000 });
  expect(sourceReads).toBe(3); reports.offlineReceipt = { capturesCompleted: 3, productConcurrency: 1, workflowsWaiting: 3 };
  await launch("receipt-host", "gnc-receipt", [], true);
  const outcomes = await Promise.all(handles.map(h => h.result()));
  reports.workflowIds = handles.map(h => h.workflowId);
  expect(outcomes.map(o => o.status)).toEqual(["durable", "durable", "durable"]);
  const catalogEvidence = JSON.parse(objects.get(pathFor(gncKeys(catalog).evidence))!.toString());
  expect(catalogEvidence.data.completion).toBe("unverified_end");
  const history = await handles[0]!.fetchHistory();
  await Worker.runReplayHistory({ workflowBundle: { codePath: resolve("dist/gnc/gnc-workflows.cjs") } }, history);
  for (const event of history.events ?? []) if (event.activityTaskScheduledEventAttributes) expect(event.activityTaskScheduledEventAttributes.retryPolicy?.maximumAttempts).toBe(1);
  await stop(productChild);
  const before = { sourceReads, puts };
  productChild = await launch("product-cold-host", "gnc-product", [productA, productB, broken], true);
  expect(await (await start(productA)).result()).toEqual(outcomes[0]);
  expect({ sourceReads, puts }).toEqual(before); reports.coldReplacement = { sourceReads: 0, puts: 0, sameReceipt: true };
});
it("parser failures retain original HTML and one passive Review across another empty-cache process", async () => {
  await stop(productChild); productChild = await launch("broken-host", "gnc-product", [broken]);
  const out = await (await start(broken)).result();
  expect(out).toMatchObject({ status: "review", code: "GNC.SKU_UNVERIFIED", automaticRetry: false });
  expect(objects.has(pathFor(gncKeys(broken).source))).toBe(true); expect(objects.has(pathFor(gncKeys(broken).completion))).toBe(false);
  await stop(productChild); const before = { sourceReads, puts };
  productChild = await launch("broken-cold-host", "gnc-product", [broken], true);
  expect(await (await start(broken)).result()).toEqual(out); expect({ sourceReads, puts }).toEqual(before);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM review_record")).rows[0].n).toBe(1);
  reports.parserFailure = { code: out.code, sourceRetained: true, duplicateReviewRows: 0, replacementSourceReads: 0 };
});
it("lost Activity acknowledgement recovers existing evidence, and unapproved tasks never fetch", async () => {
  // Fault injection only at the Activity boundary, after the preceding real process produced durable evidence.
  await stop(productChild); let attempts = 0;
  const worker = await Worker.create({ connection: temporal.nativeConnection, taskQueue: GNC_QUEUES.product, activities: {
    captureGncProduct: async () => { attempts++; throw ApplicationFailure.nonRetryable("Synthetic acknowledgement loss", "TEST.LOST_ACK"); },
  } });
  const before = { sourceReads, puts };
  await worker.runUntil(async () => { expect(await (await start(productA)).result()).toMatchObject({ status: "durable", operationId: productA.capture.operationId }); });
  expect(attempts).toBe(1); expect({ sourceReads, puts }).toEqual(before);
  productChild = await launch("no-grant-host", "gnc-product", [], true);
  const unknown = task("unapproved"), out = await (await start(unknown)).result();
  expect(out).toMatchObject({ status: "review", code: "GNC.NOT_DURABLE" }); expect({ sourceReads, puts }).toEqual(before);
  reports.lostAck = { attempts, sourceReads: 0, puts: 0, recoveredDurable: true };
});
it("cancellation while the capture queue is unserved never schedules receipt or source I/O", async () => {
  await stop(productChild); const before = { sourceReads, puts }, handle = await start(task("cancelled"));
  await vi.waitFor(async () => expect((await handle.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "captureGncProduct")).toBe(true));
  await handle.cancel(); await expect(handle.result()).rejects.toThrow();
  const history = await handle.fetchHistory();
  expect(history.events?.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "resolveGncReceipt")).toBe(false);
  expect({ sourceReads, puts }).toEqual(before);
});

it("GNC parent streams a SKU page before image downloads, then collects verified mixed evidence without recrawling on replay", async () => {
  const capture = task("chain-capture", "123459"), base = textFixture(), local = new MemoryObjects(), reviews = new PostgresReviews(db.pool);
  capture.network = { routeId: "fixture-proxy", version: "1", mode: "static-proxy", managed: true, egressId: "proxy/1" };
  capture.capture.binding.egressId = "proxy/1";
  pages.set("/123459.html", `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", sku: "123459", name: "Test", image: ["https://www.gnc.com/label.png", "https://www.gnc.com/marketing.png"] })}</script><div id="productIngredientsAccordionContent"><p>1 capsule Blend 10 mg Other ingredients: Water</p></div><div class="recommendation">Unrelated Product 999 mg</div>`);
  const remote: ObjectStore = { read: async (key, max) => { const b = objects.get(pathFor(key)); if (b && b.length > max) throw Error("limit"); return b ?? null; },
    create: async (key, bytes) => { puts++; if (objects.has(pathFor(key))) return "exists"; objects.set(pathFor(key), Buffer.from(bytes)); return "created"; } };
  const copies = await FileCopies.open(join(root, "chain-cache")), artifacts = new ArtifactResolver(copies, remote), registry = new PostgresResultRegistry(db.pool);
  const ocrResults = new OcrResultHandoff("fixture-r2/1", copies, remote, await FileCompletionJournal.open(join(root, "chain-ocr-journal")), registry);
  const screen = new RegisteredOcrEvidence(artifacts, ocrResults, registry), keywords = new KeywordPublication(local, remote);
  const textEvidence = new TextEvidence(artifacts, ocrResults), texts = new TextHandoff(local, remote, new PostgresTextRegistry(db.pool), textEvidence, "fixture-r2/1");
  const supported = { ...base.provider.supported, implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 as const };
  const ocrSupported = { schemaVersion: 1 as const, module: "ocr.file" as const, implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2 as const, configFingerprint: "b".repeat(64) };
  const input: GncProductInput = { operationId: "chain-product", task: capture, text: supported, ocr: ocrSupported, visionConfigFingerprint: "c".repeat(64) };
  let textCalls = 0, ocrCalls = 0, visionCalls = 0;
  const q = (text: string) => ({ fromLine: 1, toLine: 1, text });
  const text = new TextModule({ provider: { ...base.provider, supported, interpret: async () => { textCalls++; return JSON.stringify({
    formula: { servingSize: q("1 capsule"), nutrients: [{ name: q("Blend"), amount: q("10 mg"), dailyValue: null }] },
    ingredients: { items: [{ quote: q("Water"), role: "other", parentNutrientIndex: null }] }, excluded: [{ quote: q("Other ingredients:"), reason: "heading" }], issues: [] }); } },
    handoff: texts, reviews, nodeId: "chain-text" });
  const textReceipt = new ResolveTextReceipt({ results: texts, local, reviews });
  const nonmatch = new Set<string>();
  const ocr = new OcrFileModule({ provider: { provider: "fixture/1", supported: ocrSupported, close: async () => {}, recognize: async file => {
    ocrCalls++; return { text: nonmatch.has(file.artifactId) ? "Marketing image" : "Supplement Facts Ingredients", lines: [] }; } },
    artifacts, intents: new OcrIntents(remote, "chain-ocr", "fixture-r2/1"), results: ocrResults, reviews });
  const ocrReceipt = new ResolveOcrReceipt({ results: ocrResults, local, reviews });
  const visions = new VisionHandoff(local, remote, new PostgresVisionRegistry(db.pool), "fixture-r2/1", async (task, s) => { await screen.verifiedText(task.input.selection, s); });
  const vision = new VisionModule({ provider: { fingerprint: input.visionConfigFingerprint, interpret: async () => { visionCalls++; return JSON.stringify(visionCandidate); } },
    store: remote, localEvidence: local, verifiedOcrText: (selected, s) => screen.verifiedText(selected, s), resolve: async (file, s, owner) => (await artifacts.resolve(file, owner, s)).bytes });
  const fileEvidence = new FileEvidence({ local, remote, copies, reviews }), pageEvidence = new PageEvidence({ local, remote, reviews });
  const pagePrepare = new PreparePageModule(pageEvidence), pageText = new PreparePageText(pageEvidence), imagePrepare = new PrepareImageOcr(fileEvidence);
  const plans = new GncProductPlans(new GncCaptureEvidence({ local, remote, reviews }));
  const saved = new SavedSourceEvidence({ remote, pages: pageEvidence, files: fileEvidence, reviews, ocr: registry, screen });
  const assembly = new ProductEvidenceAssembly({ local, remote, reviews, saved, vision: visions, text: { readCandidate: async (task, s) => {
    const facts = await texts.inspect(task, s); if (!facts.record || !facts.resultRegistered || !facts.artifactDurable) throw Error("unverified");
    const bytes = await remote.read(facts.record.result.objectKey, 524288, s); if (!bytes) throw Error("missing"); verifyBytes(facts.record.result, bytes, 524288);
    const candidate = TextOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString())).candidate;
    if ("codec" in candidate) throw Error("MIXED.TEXT_PROTOCOL_UNSUPPORTED");
    return { record: facts.record, candidate, fullText: (await textEvidence.resolve(task, s)).text };
  } } });
  const collection = new CollectMixedProduct({ assembly, registry: new PostgresMixedCollectedProducts(db.pool), local, remote, reviews });
  const workers: Worker[] = [], runs: Promise<void>[] = [];
  const add = async (queue: string, activities: Record<string, (...args: any[]) => Promise<unknown>>) => {
    const w = await Worker.create({ connection: temporal.nativeConnection, taskQueue: queue, activities }); workers.push(w); runs.push(w.run());
  };
  const queue = (name: string) => `gnc-chain-${name}`, queues = { page: queue("page"), pageText: queue("page-text"), text: queue("text"), textReceipts: queue("text-receipt"),
    acquire: GNC_PRODUCT_QUEUES.files, imagePrepare: queue("image-prepare"), ocr: queue("ocr"), ocrReceipts: queue("ocr-receipt"), keywords: queue("keywords"), vision: queue("vision"), assembly: queue("assembly"), collection: queue("collection") };
  let planner: ChildProcess | undefined;
  let fileWorker: ChildProcess | undefined;
  try {
    const bundle = await bundleWorkflowCode({ workflowsPath: resolve("../../packages/v3-product/src/saved-workflow.ts") });
    const w = await Worker.create({ connection: temporal.nativeConnection, taskQueue: GNC_PRODUCT_QUEUES.saved, workflowBundle: bundle }); workers.push(w); runs.push(w.run());
    await add(queues.page, { prepareHtmlPage: raw => pagePrepare.run(raw, signal()) });
    await add(queues.pageText, { preparePageText: raw => pageText.run(raw, signal()) });
    await add(queues.text, { interpretText: raw => text.run(raw, signal()) });
    await add(queues.textReceipts, { resolveTextReceipt: raw => textReceipt.run(raw, signal()) });
    await add(queues.imagePrepare, { prepareImageOcr: raw => imagePrepare.run(raw, signal()) });
    await add(queues.ocr, { ocrFile: raw => ocr.run(raw, signal()) });
    await add(queues.ocrReceipts, { resolveOcrReceipt: raw => ocrReceipt.run(raw, signal()) });
    await add(queues.keywords, { screenImageKeywords: async raw => { const result = await screen.screen(raw, signal()); return { status: result.status, imageId: result.image.artifactId, selection: result, ...await keywords.publish(result, signal()) }; } });
    await add(queues.vision, { interpretImage: async (task: VisionTask) => {
      const old = await visions.inspect(task, signal()); if (old) return { status: "registered", operationId: task.input.operationId };
      const result = await vision.run(task.input, signal()); if (result.status === "review") throw Error(result.code!);
      await visions.complete(task, signal()); return { status: "registered", operationId: task.input.operationId };
    } });
    await add(queues.assembly, { assembleProductEvidence: raw => assembly.run(raw, signal()) });
    await add(queues.collection, { collectMixedProduct: raw => collection.run(raw, signal()) });
    productChild = await launch("chain-capture", "gnc-product", [capture]);
    planner = await launch("chain-planner", "gnc-product-input", [], true);
    await launch("chain-parent", "gnc-product-workflow");
    const begin = () => temporal.client.workflow.start("GncProductWorkflow", { taskQueue: GNC_PRODUCT_QUEUES.workflow, workflowId: `gnc-chain-${randomUUID()}`, args: [{ input, queues }], workflowExecutionTimeout: "2 minutes" });
    const handle = await begin();
    await vi.waitFor(async () => {
      const plan = await plans.inspect(input, signal()); expect(plan).not.toBeNull();
      const source = plan!.manifest.sources.find(s => s.kind === "page")!; if (source.kind !== "page") throw Error();
      expect(await new PostgresTextRegistry(db.pool).read(source.plan.textOperationId)).not.toBeNull();
    }, { timeout: 15000 });
    expect(downloads).toBe(0); expect(textCalls).toBe(1); expect(await new PostgresMixedCollectedProducts(db.pool).read(input.operationId)).toBeNull();
    const plan = (await plans.inspect(input, signal()))!;
    const marketing = plan.manifest.sources.find(s => s.id === "image-1")!; if (marketing.kind !== "file-image") throw Error(); nonmatch.add(marketing.plan.imageId);
    fileWorker = await launch("chain-file", "gnc-file", [], false, [input]);
    const out = await handle.result(); expect(out, JSON.stringify(out)).toMatchObject({ status: "collected", operationId: input.operationId });
    const history = await temporal.client.workflow.getHandle(`${handle.workflowId}-process`).fetchHistory();
    const fileActivities = (history.events ?? []).flatMap(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "acquireSourceFile" ? [e.activityTaskScheduledEventAttributes] : []);
    expect(fileActivities).toHaveLength(2);
    for (const a of fileActivities) {
      expect(a.taskQueue?.name).toBe(GNC_PRODUCT_QUEUES.files); expect(a.retryPolicy?.maximumAttempts).toBe(1);
      const payload = a.input?.payloads?.map(p => Buffer.from(p.data ?? []).toString()).join("") ?? "";
      for (const privateValue of ["https://www.gnc.com/label", "image-only", "proxyUrl", "headersByOrigin"]) expect(payload).not.toContain(privateValue);
    }
    expect({ downloads, textCalls, ocrCalls, visionCalls }).toEqual({ downloads: 2, textCalls: 1, ocrCalls: 2, visionCalls: 1 });
    expect(tunnels).toHaveLength(2); // synthetic CDP supplies HTML; two actual file CONNECTs
    expect([...imageRequests].sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: "/label.png", cookie: "image-only", proxyAuth: undefined }, { path: "/marketing.png", cookie: "image-only", proxyAuth: undefined }]);
    const record = (await new PostgresMixedCollectedProducts(db.pool).read(input.operationId))!;
    expect(record.ingredients.some(i => i.role === "other" && i.name.text === "Water")).toBe(true);
    expect(record.warnings).toContainEqual({ id: "image-1", code: "SCREEN.NO_KEYWORDS" });
    const joined = JSON.parse(objects.get(pathFor(out.evidenceKey))!.toString()); expect(joined.input.manifest.sources).toHaveLength(3);
    await stop(productChild); await stop(planner); await stop(fileWorker);
    productChild = await launch("chain-cold-capture", "gnc-product", [capture], true); planner = await launch("chain-cold-planner", "gnc-product-input", [], true);
    fileWorker = await launch("chain-cold-file", "gnc-file", [], true, [input]);
    const before = { downloads, textCalls, ocrCalls, visionCalls, sourceReads, puts };
    expect(await (await begin()).result()).toEqual(out); expect({ downloads, textCalls, ocrCalls, visionCalls, sourceReads, puts }).toEqual(before);
    const label = plan.manifest.sources.find(s => s.id === "image-0")!; if (label.kind !== "file-image") throw Error();
    const file = (await fileEvidence.inspect(label.plan.acquire, signal()))!.file, key = pathFor(file.objectKey), original = objects.get(key)!;
    objects.set(key, Buffer.from("corrupt"));
    try { expect(await collection.run({ join: joined.input, evidenceKey: out.evidenceKey }, signal())).toMatchObject({ status: "review" }); }
    finally { objects.set(key, original); }
    reports.productChain = { productOperationId: input.operationId, pageCompletedBeforeDownloads: true, sources: 3, downloads, textCalls, ocrCalls, visionCalls,
      collected: true, coldRepeatNewCalls: 0, coldRepeatPuts: 0, corruptImageRejected: true, planKey: gncProductKey(input), workflowId: handle.workflowId,
      proxyTunnels: tunnels.length, capture: "synthetic CDP fixture, not a real Chrome", fileWorker: "independent production entry; real CONNECT/TLS to local synthetic origin",
      downstreamWorkers: "real module SDK Workers in test process; model providers synthetic" };
  } finally { for (const w of workers) w.shutdown(); await Promise.all(runs); if (planner) await stop(planner); if (fileWorker) await stop(fileWorker); }
}, 60000);
