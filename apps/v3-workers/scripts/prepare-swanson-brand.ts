/** Prepare a bounded Mini deployment. No process switching, browser work or Workflow submission. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { artifactBuildId, parseWorkerConfig, taskQueueFor } from "@crawl-automation/v3-worker-runtime";
import { CodexTextProvider } from "@crawl-automation/v3-text";
import { CodexVisionProvider } from "@crawl-automation/v3-vision";
import { MultipartOcr } from "@crawl-automation/v3-ocr";
import { PostgresBrands } from "../../v3-api/src/storage/postgres-brands.js";
import { schemaStatus, migrationNames, digest, migrate } from "../../v3-api/src/bootstrap/schema.js";
import { DeploymentSchema } from "../src/deployment-supervisor.js";
import { SwansonLiveConfigSchema } from "../src/swanson-live-config.js";
import { readGncPrivateJson } from "../src/gnc-config.js";

const [flag, root] = process.argv.slice(2);
assert.equal(flag, "--prepare-bounded-brand");
assert.equal(root, "/Users/barry/apps/crawlv3-batch-a.UiA4dx");
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
const release = dirname(fileURLToPath(import.meta.url));
assert.equal(dirname(release), root);
assert.match(basename(release), /^release-swanson-mainflow-20260910(?:-[a-z0-9]+)?$/);
const stateDir = join(root, "live/swanson-mainflow-20260910");
const dir = join(stateDir, basename(release));
await mkdir(dir, { recursive: true, mode: 0o700 });
async function retained(name: string, value: unknown) {
  const path = join(dir, name), content = JSON.stringify(value, null, 2);
  try { await writeFile(path, content, { mode: 0o600, flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; assert.equal(await readFile(path, "utf8"), content, `Changed ${name}`); }
  return path;
}
let intent: any;
try { intent = await readGncPrivateJson(join(stateDir, "intent.json")); }
catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  intent = { id: randomUUID(), brandRequest: randomUUID(), sourceRequest: randomUUID(), enableRequest: randomUUID() };
  await writeFile(join(stateDir, "intent.json"), JSON.stringify(intent, null, 2), { mode: 0o600, flag: "wx" });
}
const original = DeploymentSchema.parse(await readGncPrivateJson(join(root, "live/deployment.json")));
assert.ok(original.jobs.some(j => j.id === "gnc-live-capture"));
const runtime = parseWorkerConfig(await readGncPrivateJson(join(root, "live/resource-admission/runtime.json")));
const oldWeb = await readGncPrivateJson(join(root, "live/web.json")) as any;
const oldText = await readGncPrivateJson(join(root, "live/codex-text/private.json")) as any;
assert.equal(new URL(original.database.connectionString).pathname, "/crawler_v3_test");
assert.equal(oldText.r2.bucket, "supply-smart-test");
const db = new pg.Pool({ connectionString: original.database.connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
try {
  const migrations = await Promise.all(migrationNames.map(async name => { const sql = await readFile(join(release, "migrations", name), "utf8"); return { name, sql, sha256: digest(sql) }; }));
  for (const sql of ["SELECT count(*)::int n FROM source_submission_guard", "SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL"])
    assert.equal((await db.query(sql)).rows[0].n, 0, "Existing deployment must be drained");
  const pending = (await schemaStatus(db, migrations)).pending;
  if (pending.length) {
    assert.equal(process.argv[4], "--apply-migration-016", "Explicit migration is required before preparing deployment");
    assert.deepEqual(pending, ["016_visual_wire_v2.sql"]);
    const fingerprint = async () => {
      const rows = [];
      for (const table of ["collected_product", "review_record", "processing_result"])
        rows.push({ table, rows: (await db.query(`SELECT record_hash FROM ${table} ORDER BY record_hash`)).rows });
      return { sha256: digest(JSON.stringify(rows)), counts: rows.map(r => ({ table: r.table, count: r.rows.length })) };
    };
    const before = await fingerprint(), client = await db.connect();
    try {
      await migrate(client, migrations, async () => {
        const ready = await readGncPrivateJson(join(root, "live/ready.json")) as any;
        assert.equal(ready.container, "crawlv3-batch-a-845a2138");
        const dump = await promisify(execFile)("/opt/homebrew/bin/docker", ["exec", ready.container, "pg_dump", "-U", "v3_admin", "-d", "crawler_v3_test"], { maxBuffer: 128 * 1024 * 1024, timeout: 30000 });
        assert.ok(dump.stdout.includes("PostgreSQL database dump"));
        await writeFile(join(dir, `before-016-${randomUUID()}.sql`), dump.stdout, { mode: 0o600, flag: "wx" });
      });
    } finally { client.release(); }
    assert.deepEqual(await fingerprint(), before);
    await retained("migration-016-proof.json", { migration: pending[0], preserved: before });
  }
  assert.deepEqual((await schemaStatus(db, migrations)).pending, []);
  const before = Object.fromEntries(await Promise.all(["collected_product", "review_record", "processing_result"].map(async table => [table, (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n])));
  await retained("baseline.json", before);
  const brands = new PostgresBrands(db);
  const brand = (await brands.create({ name: "A.C. Grace Company", note: "Swanson有限真实Brand验收；独立V3测试库。目录与默认变体覆盖有限。" }, intent.brandRequest)).value;
  const source = (await brands.createSource(brand.id, { channel: "swanson", region: "US", url: "https://www.swansonvitamins.com/collections/brand-ac-grace-company" }, intent.sourceRequest)).value;
  const enabled = (await brands.toggleSource(brand.id, source.id, { revision: source.revision, enabled: true }, intent.enableRequest)).value;
  const scope = { brandId: brand.id, sourceId: source.id, channel: "swanson", region: "US", rootUrl: source.url, scopeVersion: `source-revision-${enabled.revision}` };
  const storage = { r2: { ...oldText.r2, prefix: `crawlv3-acceptance/swanson-brand-${intent.id}` }, r2Credentials: oldText.r2Credentials };
  const codex = { settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" }, executable: "/opt/homebrew/bin/codex", codexHome: "/Users/barry/.codex", workRoot: join(dir, "model-work"), runtimeProfileVersion: "gnc-persistent-auth/1", timeoutMs: 240000, disabledMcpServers: ["node_repl", "computer-use"], extractionProtocol: "label-extraction/1" };
  const ocrProvider = { endpoint: "http://192.168.0.6:8081/ocr", trustedHttpOrigin: "http://192.168.0.6:8081", provider: "paddle-ocr/1", minScore: 0.3 };
  const code = (await readdir(release)).filter(n => n.endsWith(".js")).sort().map(n => join(release, n));
  const activityBuild = await artifactBuildId(code), workflowBuild = await artifactBuildId([...code, join(release, "product-workflows.cjs")].sort());
  const queueScope = `sw-${intent.id.slice(0, 16)}`;
  const jobs: any[] = [], queues: Record<string, string> = {};
  async function define(key: string, role: string, entry: string, capability: string, compatibility: string, variable?: string, configPath?: string, workflow = false) {
    const config = parseWorkerConfig({ ...runtime, role, capability, compatibility, contractVersion: 1, expectedBuildId: workflow ? workflowBuild : activityBuild,
      hostId: `mini-${role}`, queueScope, concurrency: workflow ? 4 : key === "resources" ? 4 : 1, startupTimeoutMs: 120000 });
    const env: Record<string, string> = { V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: await retained(`${role}.runtime.json`, config) };
    if (variable) { env[`${variable}_ENABLED`] = "true"; env[`${variable}_CONFIG`] = configPath!; }
    jobs.push({ id: role, entry: join(release, `${entry}.js`), env }); queues[key] = taskQueueFor(config);
  }
  const labelRoot = join(dir, "label");
  const labelPrivate = await retained("label.private.json", { root: labelRoot, storageId: `swanson-${intent.id}`, database: original.database, ...storage, codex, ocrProvider });
  const names: Record<string, string> = { plan: "plan", page: "page", pageText: "page-text", imagePrepare: "image-prepare", ocr: "ocr", ocrReceipts: "ocr-receipts", keywords: "keywords", source: "source", manifest: "manifest", text: "text", textReceipts: "text-receipts", vision: "vision", core: "core", assembly: "assembly", collection: "collection", review: "review", resources: "resources" };
  for (const [key, name] of Object.entries(names)) await define(key, `channel-label-${name}`, "channel-label-worker", `channel.label.${name}`, "channel-label-v1", "V3_CHANNEL_LABEL", labelPrivate);
  const labelQueues = Object.fromEntries(Object.keys(names).filter(n => n !== "resources").map(n => [n, queues[n]]));
  const swansonPrivate = join(dir, "swanson.private.json");
  for (const role of ["control", "catalog-source", "catalog-ledger", "product-input", "capture", "file", "review"])
    await define(`swanson-${role}`, `swanson-${role}`, "swanson-live-worker", `swanson.${role}`, "swanson-live-v1", "V3_SWANSON_LIVE", swansonPrivate);
  const planPrivate = await retained("plan.private.json", { cacheRoot: join(dir, "plan-cache"), journalRoot: join(dir, "plan-journal"), reviewDatabase: original.database, ...storage });
  await define("productPlan", "channel-product-input", "channel-plan-worker", "channel.product-input", "channel-plan-v1", "V3_CHANNEL_PLAN", planPrivate);
  for (const [key, role, cap, compat] of [["brandWorkflow", "swanson-brand-workflow", "swanson.control", "swanson-live-v1"], ["productWorkflow", "swanson-product-workflow", "swanson.product-input", "swanson-live-v1"], ["catalogWorkflow", "catalog-workflow", "catalog.workflow", "catalog-v1"], ["labelWorkflow", "channel-label-workflow", "channel.saved-label", "channel-label-v1"]])
    await define(key!, role!, "product-workflow-worker", cap!, compat!, undefined, undefined, true);
  const browserNeeds = [{ resourceId: "mini-ego-space-1", units: 1 }], modelNeeds = [{ resourceId: "mini-model-account", units: 1 }, { resourceId: "mini-cpu", units: 1 }];
  const gate = (activities: any, reviewStopCheck = false) => ({ queue: queues.resources, activities, maxWaitSeconds: 900, reviewStopCheck });
  const sourceText = CodexTextProvider.describe({ ...codex, extractionProtocol: undefined });
  const text = CodexTextProvider.describe(codex), vision = CodexVisionProvider.describe(codex), ocr = new MultipartOcr(ocrProvider);
  const config = SwansonLiveConfigSchema.parse({ clusterId: "railway-temporal", database: original.database, ...storage,
    journalRoot: join(dir, "source-journal"), pageJournalRoot: join(dir, "browser-pages"), cacheRoot: join(dir, "source-cache"),
    browser: { engine: "ego-lite", sdk: "1", cliPath: "/Users/barry/.local/bin/ego-browser", taskSpaceId: 1 }, browserResource: "mini-ego-space-1", egressId: "mini-ego-host/1", scope, brandName: brand.name,
    catalogQueue: queues.catalogWorkflow, catalogQueues: { source: queues["swanson-catalog-source"], ledger: queues["swanson-catalog-ledger"], product: queues.productWorkflow },
    catalogResources: gate({ readCatalogPage: browserNeeds }), productQueues: { capture: queues["swanson-capture"], plan: queues.productPlan, file: queues["swanson-file"], label: queues.labelWorkflow, review: queues["swanson-review"] },
    productResources: gate({ browserSession: browserNeeds }), sourceText, ocr: ocr.supported, sourceVisionConfigFingerprint: vision.configFingerprint,
    labelText: text, visionConfigFingerprint: vision.configFingerprint, evidencePolicy: "label-image-first/3", labelQueues,
    labelResources: gate({ interpretText: modelNeeds, interpretImage: modelNeeds, ocrFile: [{ resourceId: "windows-ocr", units: 1 }] }, true) });
  await ocr.close(); await retained("swanson.private.json", config);
  // The original GNC intent target remains immutable. Only fresh Swanson requests use this scoped queue.
  const target = { ...oldWeb.delivery.target, taskQueue: queues.brandWorkflow };
  const web = { ...oldWeb, port: 4189, delivery: { ...oldWeb.delivery, channelTargets: { gnc: oldWeb.delivery.target, swanson: target }, pauseFile: join(dir, "delivery-paused") } };
  const webPrivate = await retained("web.private.json", web);
  jobs.push({ id: "brand-web", entry: join(release, "brand-web.js"), env: { V3_BRAND_WEB_ENABLED: "true", V3_BRAND_WEB_CONFIG: webPrivate } });
  const resourceJobs: Record<string, string[]> = { "mini-ego-space-1": ["swanson-capture", "swanson-file", "swanson-catalog-source"], "mini-cpu": ["channel-label-text", "channel-label-vision"], "mini-model-account": ["channel-label-text", "channel-label-vision"], "windows-ocr": ["channel-label-ocr"] };
  const dependencies = original.dependencyProbes!.map(probe => {
    if (probe.kind !== "handoff-backlog") return probe;
    return { ...probe, roots: probe.id === "ocr-handoff" ? [{ root: join(labelRoot, "ocr/ocr-journal"), layout: "ocr" }] : [{ root: join(labelRoot, "text/journal"), layout: "text" }, { root: join(labelRoot, "vision/journal"), layout: "vision" }] };
  });
  for (const probe of dependencies) if (probe.kind === "handoff-backlog") for (const r of probe.roots) await mkdir(r.root, { recursive: true, mode: 0o700 });
  const manifest = DeploymentSchema.parse({ ...original, jobs, resources: original.resources.map(r => ({ ...r, jobs: resourceJobs[r.resourceId] })), dependencyProbes: dependencies });
  await retained("original-deployment.json", original); await retained("deployment.json", manifest);
  await retained("ready.json", { id: intent.id, root, dir, release, manifestPath: join(dir, "deployment.json"), jobs: jobs.map(j => j.id), namespace: runtime.namespace, queueScope,
    scope, sourceRevision: enabled.revision, target, activityBuild, workflowBuild, evidencePolicy: config.evidencePolicy, model: codex.settings, r2Prefix: storage.r2.prefix,
    url: `http://127.0.0.1:4189/v3-live.html?brand=${brand.id}`, submissionCount: 0 });
  console.log(JSON.stringify({ event: "SWANSON_BRAND_PREPARED", dir, workers: jobs.length, scope, queueScope, submissionCount: 0 }));
} finally { await db.end(); }
