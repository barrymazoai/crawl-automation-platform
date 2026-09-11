// One approved SKU, real Railway Temporal, separate business processes. Never automatically rerun this root.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, lstat, open } from "node:fs/promises";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { parseEnv, promisify } from "node:util";
import assert from "node:assert/strict";
import pg from "pg";
import { Connection, Client, type WorkflowHandle } from "@temporalio/client";
import { msToTs } from "@temporalio/common/lib/time.js";
import { GncAcquireInputSchema, GncProductInputSchema, GncStreamingLabelWorkflowInputSchema, LabelProductWorkflowInputSchema } from "@crawl-automation/v3-contracts";
import { CodexTextProvider } from "@crawl-automation/v3-text";
import { CodexVisionProvider } from "@crawl-automation/v3-vision";
import { MultipartOcr } from "@crawl-automation/v3-ocr";
import { migrate, migrationNames } from "../../v3-api/src/bootstrap/schema.js";
import { LaneSession, NodeSourceProcesses } from "@crawl-automation/v3-acquisition";
import { taskQueueFor } from "@crawl-automation/v3-worker-runtime";
import { miniDefaultClash } from "./mini-default-clash-host.js";
import { operatorReadyGate } from "./operator-ready-gate.js";
import { prepareSavedGnc, savedGncPrefix, savedGncStorageId } from "./mini-saved-label-evidence.js";

const [flag, root, accessMode, ...extra] = process.argv.slice(2);
const egoSaved = flag === "--authorized-ego-downstream";
const liveCore = flag === "--authorized-pool-core-one";
const pooled = flag === "--authorized-pool-one" || liveCore;
const rejoin = flag === "--authorized-core-rejoin";
const coreOnly = flag === "--authorized-core-activity";
const corePreparation = flag === "--authorized-core-one" || rejoin || liveCore || egoSaved;
const coreStreaming = liveCore || egoSaved;
const saved = flag === "--authorized-prepared-one" || (corePreparation && !coreStreaming) || coreOnly;
assert.equal(extra.length, 0);
assert.ok(accessMode === undefined || rejoin || (pooled && accessMode === "--operator-ready"));
if (rejoin) assert.match(accessMode!, /^\/Users\/barry\/apps\/crawlv3-gnc-saved\.[A-Za-z0-9]+\/live$/);
const operatorReady = accessMode === "--operator-ready";
// GNC's current explicit core entry uses the installed native mouse helper, not Codex.
const nativeMouse = liveCore && !operatorReady;
if (operatorReady) assert.ok(process.stdin.isTTY, "OPERATOR_TTY_REQUIRED");
assert.ok(saved || pooled || egoSaved || flag === "--authorized-one"); assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
if(pooled) assert.match(root!, /^\/Users\/barry\/apps\/crawlv3-gnc-pool\.[A-Za-z0-9]+\/live$/);
else if(saved || egoSaved) assert.match(root!, /^\/Users\/barry\/apps\/crawlv3-gnc-saved\.[A-Za-z0-9]+\/live$/);
else assert.equal(root, "/Users/barry/apps/crawlv3-gnc-e2e.FzqLa3/live");
const parent = pooled || saved || egoSaved ? "/Users/barry/apps/crawlv3-gnc-e2e.FzqLa3" : dirname(root!), dist = dirname(fileURLToPath(import.meta.url)), exec = promisify(execFile);
const id = randomUUID(), namespace = `gnc-live-${id}`, container = `crawlv3-gnc-${id.slice(0, 8)}`;
const children: { role: string; child: ChildProcess; log: string }[] = [];
const report: Record<string, any> = { at: new Date().toISOString(), id, namespace, container, status: "preparing", realProviders: !rejoin && !coreOnly,
  internalModelRequests: "codex-managed", model: "gpt-5.6-luna", effort: "medium", sku: "613701", submittedWorkflows: 0, workers: [],
  inputMode: egoSaved ? "ego-saved-plan-readonly-files" : coreOnly ? "saved-core-activity-only" : liveCore ? "live-capture-core" : rejoin ? "saved-registered-core-rejoin" : corePreparation ? "saved-evidence-core-new-generation" : saved ? "saved-evidence-new-generation" : "live-capture" };
let connection: Connection | undefined, handle: (WorkflowHandle & { firstExecutionRunId: string }) | undefined, db: pg.Pool | undefined, owned = false, containerStarted = false;
let stage = "preparation", terminal = false;
let laneSession: LaneSession | undefined, fileOperations: string[] = [];
const save = async () => { if (owned) await writeFile(join(root!, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); };
const privateJson = async (name: string, value: unknown) => {
  const path = join(root!, name); await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" }); return path;
};
async function until(check: () => Promise<boolean>, timeout = 60000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error("WAIT_TIMEOUT"); await new Promise(r => setTimeout(r, 500)); }
}
async function main() {
  await mkdir(root!, { mode: 0o700 }); owned = true;
  await privateJson("intent.json", { id, namespace, container, target: "https://www.gnc.com/energy/613701.html" }); await save();
  let restored: any;
  if(pooled) {
    stage="lane-admission";
    const host=await miniDefaultClash(); await mkdir(join(root!,"sessions"),{mode:0o700});
    laneSession=await LaneSession.open({ownerId:`gnc-live-${id}`,sessionsRoot:join(root!,"sessions"),endpoints:host.endpoints},host.pool,
      new NodeSourceProcesses({chromeExecutable:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:!(operatorReady || nativeMouse),profilesRoot:host.profilesRoot,startupMs:120000,stopMs:35000}),AbortSignal.timeout(60000));
    restored={status:"ready",browser:laneSession.browser.config,proxyPort:Number(new URL(laneSession.proxyUrl).port)};
    report.lane={laneId:laneSession.grant.laneId,sessionId:laneSession.grant.sessionId,browserPid:laneSession.browser.pid,mode:"default-clash",
      headless:!(operatorReady || nativeMouse),profilePath:join(host.profilesRoot,laneSession.grant.laneId,"profile")};
    report.nativeMouse = nativeMouse;
    await save();
    if (operatorReady) {
      stage = "operator-readiness";
      report.accessPreparation = { status: "waiting", timeoutMs: 600000, automaticCaptcha: false };
      await save();
      console.log(JSON.stringify({event:"OPERATOR_READY_REQUIRED",root,lane:report.lane,
        target:"https://www.gnc.com/energy/613701.html",statement:"PRODUCT_613701_READY"}));
      const controller = new AbortController(), abort = () => controller.abort();
      process.once("SIGINT",abort); process.once("SIGTERM",abort);
      try { await operatorReadyGate(process.stdin,controller.signal); }
      finally { process.removeListener("SIGINT",abort); process.removeListener("SIGTERM",abort); }
      report.accessPreparation = { status: "operator-attested", at:new Date().toISOString(), automaticCaptcha:false };
      await save(); // Attestation is not business success; the normal Reader still validates a fresh product capture.
    }
  } else if (!saved && !egoSaved) restored = JSON.parse(await readFile(join(parent, "restored.json"), "utf8"));
  let browser: any;
  if (!saved && !egoSaved) {
  assert.equal(restored.status, "ready");
  browser = restored.browser;
  const current = await (await fetch(`${browser.endpoint}/json/version`, { signal: AbortSignal.timeout(5000) })).json() as any;
  assert.ok(current.webSocketDebuggerUrl.endsWith(`/browser/${browser.instanceId}`));
  }
  const r2Path = "/Users/barry/apps/crawlv3-gnc-live-ioVGhu/.env.r2";
  const rs = await lstat(r2Path); assert.ok(rs.isFile() && !rs.isSymbolicLink() && !(rs.mode & 0o077));
  const env = parseEnv(await readFile(r2Path, "utf8")); assert.equal(env.CLOUDFLARE_R2_BUCKET, "supply-smart-test");
  assert.ok(env.CLOUDFLARE_R2_ENDPOINT && env.CLOUDFLARE_R2_ACCESS_KEY_ID && env.CLOUDFLARE_R2_SECRET_ACCESS_KEY);
  const storage = { r2: { endpoint: env.CLOUDFLARE_R2_ENDPOINT, bucket: env.CLOUDFLARE_R2_BUCKET,
    prefix: egoSaved ? "crawlv3-acceptance/ego-1b5c6c59-9e96-49f5-a185-41ffa9d5a5d8" : saved ? savedGncPrefix : `crawlv3-acceptance/gnc-e2e-${id}`, timeoutMs: 20000 },
    r2Credentials: { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY } };
  report.prefix = storage.r2.prefix;
  const deployment = JSON.parse(await readFile(join(parent, "deployment.json"), "utf8"));
  const transport = { mode: "mtls", serverName: deployment.tlsServerName, caFile: join(parent, "ca.pem"),
    certFile: join(parent, "mac-worker.pem"), keyFile: join(parent, "mac-worker-key.pem") };
  connection = await Connection.connect({ address: deployment.address, connectTimeout: "15 seconds", tls: {
    serverNameOverride: transport.serverName, serverRootCACertificate: await readFile(transport.caFile),
    clientCertPair: { crt: await readFile(transport.certFile), key: await readFile(transport.keyFile) } } });
  await connection.workflowService.registerNamespace({ namespace, description: "One approved GNC 613701 integration; no legacy jobs",
    workflowExecutionRetentionPeriod: msToTs("7 days") });
  const client = new Client({ connection, namespace }); report.ui = `${deployment.uiUrl}/namespaces/${namespace}/workflows`;
  stage = "isolated-database";
  const password = randomUUID();
  await writeFile(join(root!, "postgres.env"), `POSTGRES_USER=v3_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`, { mode: 0o600, flag: "wx" });
  await mkdir(join(root!, "postgres-data"), { mode: 0o700 });
  await exec("docker", ["run", "-d", "--name", container, "--label", `crawlv3.run=${id}`, "--publish", "127.0.0.1::5432",
    "--env-file", join(root!, "postgres.env"), "--mount", `type=bind,src=${join(root!, "postgres-data")},dst=/var/lib/postgresql`, "postgres:18"], { timeout: 30000 });
  containerStarted = true;
  const port = Number((await exec("docker", ["port", container, "5432/tcp"])).stdout.trim().split(":").at(-1));
  assert.ok(port > 0);
  db = new pg.Pool({ host: "127.0.0.1", port, user: "v3_admin", password, database: "crawler_v3_test", max: 4, connectionTimeoutMillis: 2000 });
  await until(async () => { try { await db!.query("SELECT 1"); return true; } catch { return false; } }, 30000);
  const migrations = await Promise.all(migrationNames.map(async name => { const sql = await readFile(join(dist, "migrations", name), "utf8");
    return { name, sql, sha256: createHash("sha256").update(sql).digest("hex") }; }));
  const dbClient = await db.connect(); try { await migrate(dbClient, migrations); } finally { dbClient.release(); }
  const urls: Record<string, any> = {};
  for (const [name, table, permissions] of [["results", "processing_result", "SELECT,INSERT"], ["result_reader", "processing_result", "SELECT"],
    ["reviews", "review_record", "SELECT,INSERT"], ["collector", "collected_product", "SELECT,INSERT"]]) {
    const secret = randomUUID(), role = `v3_${name}`;
    await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await db.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT ${permissions} ON public.${table} TO ${role}`);
    urls[name!] = { connectionString: `postgresql://${role}:${secret}@127.0.0.1:${port}/crawler_v3_test`, tls: false };
  }
  const common = { ...storage, storageId: saved ? savedGncStorageId : `mini-gnc-${id.slice(0, 8)}`, resultDatabase: urls.results, reviewDatabase: urls.reviews };
  const paths = (role: string) => ({ cacheRoot: join(root!, role, "cache"), ocrJournalRoot: join(root!, role, "ocr-journal") });
  const codex = (role: string) => ({ settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
    executable: "/opt/homebrew/bin/codex", codexHome: "/Users/barry/.codex", workRoot: join(root!, role, "codex-work"),
    runtimeProfileVersion: "gnc-persistent-auth/1", timeoutMs: 240000, disabledMcpServers: ["node_repl", "computer-use"], extractionProtocol: "label-extraction/1" as const });
  const text = CodexTextProvider.describe(codex("codex-text")), vision = CodexVisionProvider.describe(codex("codex-vision"));
  const legacyText = CodexTextProvider.describe({ ...codex("metadata"), extractionProtocol: undefined });
  const ocrProvider = { endpoint: "http://192.168.0.6:8081/ocr", trustedHttpOrigin: "http://192.168.0.6:8081", provider: "paddle-ocr/1", minScore: 0.3 };
  const ocr = new MultipartOcr(ocrProvider).supported;
  const network = laneSession?.grant.route ?? { routeId: "mini-virginia-fixed", version: "private-lane-1", mode: "static-proxy", managed: true, egressId: "mini-virginia-fixed/1" };
  const task = saved || egoSaved ? undefined : GncAcquireInputSchema.parse({ schemaVersion: 1, implementationVersion: "gnc-acquire/1",
    owner: { schemaVersion: 1, requestId: `req-${id}`, observationId: `obs-${id}`, brandId: "acceptance-focus-fuel", sourceId: "gnc", listingId: "613701", variantId: null },
    capture: { kind: "product", requestId: `req-${id}`, operationId: `capture-${id}`, brandId: "acceptance-focus-fuel", sourceId: "gnc",
      url: "https://www.gnc.com/energy/613701.html", sku: "613701", binding: { sessionId: browser.sessionId, egressId: network.egressId } }, network });
  const sourcePlan = egoSaved ? GncProductInputSchema.parse(JSON.parse(await readFile("/Users/barry/apps/crawlv3-ego-files.mAw7HF/live/product-input.json", "utf8")))
    : saved ? undefined : GncProductInputSchema.parse({ operationId: `plan-${id}`, task, text: legacyText, ocr, visionConfigFingerprint: vision.configFingerprint });
  if (egoSaved) {
    assert.equal(sourcePlan!.operationId, "ego-plan-0ccedcf2-dbf4-477b-b099-7daef0f8d7cf");
    assert.equal(sourcePlan!.task.owner.listingId,"613701");
    assert.equal(sourcePlan!.task.capture.operationId,"capture-1b5c6c59-9e96-49f5-a185-41ffa9d5a5d8");
    report.browserCalls=0; report.sourceDownloads=0;
  }
  const definitions: Record<string, any> = {}, queues: Record<string, string> = {};
  async function define(key: string, role: string, entry: string, variable?: string, config?: any, concurrency = 1) {
    await mkdir(join(root!, role), { recursive: true, mode: 0o700 });
    const cfgPath = config ? await privateJson(`${role}/private.json`, config) : undefined;
    const childEnv = { ...process.env, ...(variable ? { [`${variable}_LIVE_ENABLED`]: "true", [`${variable}_CONFIG`]: cfgPath } : {}) };
    const metadata = JSON.parse((await exec(process.execPath, [join(dist, `${entry}.js`), "--list"], { env: childEnv, timeout: 30000 })).stdout).find((r: any) => r.role === role);
    assert.ok(metadata, `Missing role ${role}`);
    const runtime = { role, capability: metadata.capability, contractVersion: metadata.contractVersion, compatibility: metadata.compatibility,
      expectedBuildId: metadata.buildId, hostId: `mini-${role}`, namespace, address: deployment.address, transport,
      ...(laneSession && ["gnc-product","gnc-file"].includes(role) ? {queueScope:laneSession.grant.sessionId} : {}),
      concurrency, startupTimeoutMs: 120000, shutdownGraceMs: 10000, shutdownForceMs: 20000 };
    const runtimePath = await privateJson(`${role}/runtime.json`, runtime);
    definitions[key] = { role, entry: join(dist, `${entry}.js`), env: { ...childEnv, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtimePath } };
    queues[key] = taskQueueFor(runtime);
  }
  const gncBase = (role: string) => ({ ...storage, role, journalRoot: join(root!, role, "journal"), reviewDatabase: urls.reviews });
  if (coreOnly || coreStreaming) await define("core", "label-core-prepare", "acquisition-worker", "V3_ACQUISITION", {
    ...storage, reviewDatabase: urls.reviews, cacheRoot: paths("label-core-prepare").cacheRoot, journalRoot: join(root!, "label-core-prepare/journal") });
  await define("workflow", saved ? "product-label-workflow" : coreStreaming ? "gnc-core-stream-workflow" : "gnc-stream-label-workflow", "product-workflow-worker", undefined, undefined, 2);
  if (!saved && !egoSaved) {
  await define("capture", "gnc-product", "gnc-worker", "V3_GNC", { ...gncBase("gnc-product"), network, browser,
    ...(nativeMouse ? { nativeMouse: {browserPid:report.lane.browserPid,profilePath:report.lane.profilePath,keepChallengeOpen:true} } : {}),
    grants: [{ task, expiresAt: new Date(Date.now() + 1800000).toISOString() }] });
  await define("captureReceipts", "gnc-receipt", "gnc-worker", "V3_GNC", gncBase("gnc-receipt"));
  await define("productPlan", "gnc-product-input", "gnc-worker", "V3_GNC", gncBase("gnc-product-input"));
  }
  for (const [key, role] of [["plan", "gnc-label-plan"], ["source", "gnc-label-source"], ["manifest", "gnc-label-input"],
    ["assembly", "product-label-assembly"], ["collection", "product-label-collect"], ["ocrReceipts", "ocr-receipt"]] as const)
    if (!saved || ["assembly", "collection"].includes(key)) await define(key, coreStreaming && ["plan", "source", "manifest"].includes(key) ? role.replace("gnc-label-", "gnc-core-") : corePreparation && ["assembly", "collection"].includes(key) ? role.replace("product-label-", "product-core-") : role, "product-worker", "V3_PRODUCT", { ...common, resultDatabase: urls.result_reader, ...paths(role), productLocalRoot: join(root!, role, "evidence"),
      ...(key === "collection" ? { collectionDatabase: urls.collector } : {}) }, key === "source" ? 2 : 1);
  if (!saved) {
  for (const [key, role] of [["page", "page-prepare"], ["pageText", "page-text-input"], ["imagePrepare", "image-ocr-input"]] as const)
    await define(key, role, "acquisition-worker", "V3_ACQUISITION", { ...storage, reviewDatabase: urls.reviews, cacheRoot: paths(role).cacheRoot, journalRoot: join(root!, role, "journal") });
  await define("ocr", "ocr-file", "ocr-worker", "V3_OCR", { ...common, provider: ocrProvider, cacheRoot: paths("ocr-file").cacheRoot, journalRoot: join(root!, "ocr-file/journal") }, 2);
  await define("keywords", "ocr-keywords", "keyword-worker", "V3_KEYWORD", { ...common, resultDatabase: urls.result_reader, ...paths("ocr-keywords"), keywordLocalRoot: join(root!, "ocr-keywords/evidence") }, 2);
  }
  await define("text", "codex-text", "text-worker", "V3_TEXT", { ...common, ...paths("codex-text"), codex: codex("codex-text"), textLocalRoot: join(root!, "codex-text/evidence") });
  await define("textReceipts", "text-receipt", "text-receipt-worker", "V3_TEXT_RECEIPT", { ...common, resultDatabase: urls.result_reader, ...paths("text-receipt"), textLocalRoot: join(root!, "text-receipt/evidence") });
  await define("vision", "codex-vision", "vision-worker", "V3_VISION", { ...common, ...paths("codex-vision"), codex: codex("codex-vision"), visionLocalRoot: join(root!, "codex-vision/evidence") });
  if(egoSaved) await define("acquire","file-receipt","acquisition-worker","V3_ACQUISITION",{
    ...storage,reviewDatabase:urls.reviews,cacheRoot:paths("file-receipt").cacheRoot,journalRoot:join(root!,"file-receipt/journal")},2);
  else if (!saved) queues.acquire = taskQueueFor({capability:"gnc.file",contractVersion:1,compatibility:"gnc-file-v1",queueScope:laneSession?.grant.sessionId});
  async function launch(key: string) {
    if(laneSession && ["capture","acquire"].includes(key)) {
      const def=definitions[key];
      const child=await laneSession.startWorker(key,key==="capture"?"capture":"files",{entry:def.entry,env:def.env},key==="acquire"?fileOperations:[]);
      report.workers.push({role:def.role,pid:child.pid,queue:queues[key],lifecycle:"lane-session"});await save();
      console.log(JSON.stringify({event:"READY",role:def.role}));return;
    }
    const def = definitions[key], log = join(root!, def.role, "worker.log"), file = await open(log, "ax", 0o600);
    const child = spawn(process.execPath, [def.entry], { env: def.env, stdio: ["ignore", file.fd, file.fd] });
    children.push({ role: def.role, child, log }); await file.close();
    await until(async () => { if (child.exitCode !== null || child.signalCode !== null) throw Error(`WORKER_START_${def.role}`);
      return (await readFile(log, "utf8")).includes('"event":"WORKER_RUNNING"'); }, 120000);
    report.workers.push({ role: def.role, pid: child.pid, queue: queues[key] }); await save();
    console.log(JSON.stringify({ event: "READY", role: def.role }));
  }
  if (egoSaved) {
    const {workflow:workflowQueue,...businessQueues}=queues;
    const input=GncStreamingLabelWorkflowInputSchema.parse({start:"saved-plan",input:{operationId:`label-${id}`,sourcePlan,text,
      visionConfigFingerprint:vision.configFingerprint,corePolicy:"gnc-label-core/1"},queues:businessQueues});
    await privateJson("workflow-input.json",input);
    stage="downstream-workers";
    for(const key of Object.keys(definitions))await launch(key);
    const workflowId=`gnc-ego-downstream-613701-${id}`;report.workflowId=workflowId;
    await privateJson("submit-intent.json",{namespace,workflowId});stage="workflow";
    handle=await client.workflow.start("GncStreamingLabelWorkflow",{workflowId,taskQueue:workflowQueue!,args:[input],workflowExecutionTimeout:"25 minutes"});
    report.submittedWorkflows=1;report.runId=handle.firstExecutionRunId;await save();
    console.log(JSON.stringify({event:"SUBMITTED",workflowId,runId:report.runId,namespace,inputMode:report.inputMode}));
  } else if (saved) {
    stage = "verify-saved-evidence";
    const prepared = await prepareSavedGnc({ root: root!, dist, operationId: `saved-label-${id}`, text,
      visionFingerprint: vision.configFingerprint, db, storage: common, corePreparation, ...(rejoin ? { registeredRun: accessMode! } : {}) });
    report.savedEvidence = prepared.evidence; await privateJson("saved-evidence.json", prepared.evidence); await save();
    const { workflow: workflowQueue, core: coreQueue, ...businessQueues } = queues;
    const input = LabelProductWorkflowInputSchema.parse({ manifest: prepared.manifest, queues: businessQueues });
    const fullText = input.manifest.sources.find(s => s.kind === "text");
    if (coreOnly) assert.ok(fullText?.kind === "text" && fullText.task.source.kind === "prepared");
    const coreInput = coreOnly && fullText?.kind === "text" && fullText.task.source.kind === "prepared"
      ? { input: { owner: input.manifest.observation, fullDocument: fullText.task.source.document }, queue: coreQueue } : undefined;
    await privateJson("workflow-input.json", coreInput ?? input);
    stage = "downstream-workers";
    for (const key of Object.keys(definitions)) if (coreOnly ? ["workflow", "core"].includes(key) : !rejoin || ["workflow", "assembly", "collection"].includes(key)) await launch(key);
    const workflowId = `gnc-saved-613701-${id}`; report.workflowId = workflowId;
    await privateJson("submit-intent.json", { workflowId, namespace }); stage = "workflow";
    handle = await client.workflow.start(coreOnly ? "LabelCoreWorkflow" : rejoin ? "finishLabelProduct" : "LabelProductWorkflow", { workflowId, taskQueue: workflowQueue!,
      args: coreOnly ? [coreInput] : rejoin ? [{ manifest: input.manifest, states: input.manifest.sources.map(s => ({ id: s.id, status: "registered" })) },
        { assembly: businessQueues.assembly, collection: businessQueues.collection }] : [input], workflowExecutionTimeout: "15 minutes" });
    report.submittedWorkflows = 1; report.runId = handle.firstExecutionRunId; await save();
    console.log(JSON.stringify({ event: "SUBMITTED", workflowId, runId: report.runId, namespace, inputMode: report.inputMode }));
  } else {
  stage = "capture-workers";
  for (const key of ["workflow", "capture", "captureReceipts", "productPlan"]) await launch(key);
  const { workflow: workflowQueue, ...businessQueues } = queues;
  const input = GncStreamingLabelWorkflowInputSchema.parse({ start: "capture", input: { operationId: `label-${id}`, sourcePlan, text, visionConfigFingerprint: vision.configFingerprint,
    ...(liveCore ? { corePolicy: "gnc-label-core/1" } : {}) }, queues: businessQueues });
  await privateJson("workflow-input.json", input);
  const workflowId = `gnc-613701-${id}`; report.workflowId = workflowId;
  await privateJson("submit-intent.json", { workflowId, namespace });
  stage = "workflow";
  handle = await client.workflow.start("GncStreamingLabelWorkflow", { workflowId, taskQueue: workflowQueue!, args: [input], workflowExecutionTimeout: "25 minutes" });
  report.submittedWorkflows = 1; report.runId = handle.firstExecutionRunId; await save();
  console.log(JSON.stringify({ event: "SUBMITTED", workflowId, runId: report.runId, namespace }));
  let planComplete = false;
  await until(async () => {
    const history = await handle!.fetchHistory();
    terminal = history.events?.some(e => e.workflowExecutionCompletedEventAttributes || e.workflowExecutionFailedEventAttributes || e.workflowExecutionTimedOutEventAttributes) ?? false;
    const scheduled = history.events?.find(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "prepareGncProduct");
    planComplete = !!scheduled && !!history.events?.some(e => String(e.activityTaskCompletedEventAttributes?.scheduledEventId) === String(scheduled.eventId));
    return terminal || planComplete;
  }, 180000);
  if (!terminal) {
    stage = "file-grant";
    await mkdir(join(root!, "gnc-file"), { mode: 0o700 });
    const fileWorker = { ...gncBase("gnc-file"), cacheRoot: paths("gnc-file").cacheRoot, network, proxyUrl: `http://127.0.0.1:${restored.proxyPort}` };
    const grantConfig = await privateJson("grant-config.json", { input: sourcePlan, browser, allowedOrigins: ["https://www.gnc.com", "https://gnc.scene7.com"],
      expiresAt: new Date(Date.now() + 1200000).toISOString(), fileWorker });
    const grantOutput = join(root!, "gnc-file/granted.json");
    const grantResult = await exec(process.execPath, [join(dist, "gnc-file-grant.js")], { env: { ...process.env,
      V3_GNC_SESSION_EXPORT_ENABLED: "true", V3_GNC_GRANT_CONFIG: grantConfig, V3_GNC_GRANT_OUTPUT: grantOutput }, timeout: 120000 });
    const grantReceipt = JSON.parse(grantResult.stdout); assert.ok(grantReceipt.resources > 0 && grantReceipt.resources <= 4);
    report.fileGrant = grantReceipt;
    const granted=JSON.parse(await readFile(grantOutput,"utf8"));
    fileOperations=granted.fileGrants.flatMap((g:any)=>g.resources.map((r:any)=>r.input.operationId));
    assert.equal(new Set(fileOperations).size,fileOperations.length);
    if(laneSession) {
      await laneSession.planFiles(fileOperations);
      // Session cookies are durably exported; the grant child has exited. Downloads keep the same lane.
      await laneSession.closeCapture();report.captureStoppedBeforeDownloads=true;await save();
    }
    await define("acquire", "gnc-file", "gnc-worker", "V3_GNC", granted, 2);
    // Actual queue must match the value already placed in the immutable Workflow input.
    assert.equal(queues.acquire, input.queues.acquire);
    stage = "downstream-workers";
    for (const key of Object.keys(definitions).filter(k => !["workflow", "capture", "captureReceipts", "productPlan"].includes(k))) await launch(key);
  }
  }
  stage = "await-result";
  assert.ok(handle);
  report.outcome = await handle.result(); terminal = true; report.status = "finished";
  report.reviewRows = (await db.query("SELECT review_id,record->'failure'->>'code' AS code FROM review_record ORDER BY registered_at")).rows;
  report.resultRows = (await db.query("SELECT operation_id,record->'input'->>'module' AS module FROM processing_result ORDER BY registered_at")).rows;
  report.collectedRows = (await db.query("SELECT operation_id,record->>'codec' AS codec FROM collected_product")).rows;
  await save();
}
await main().catch(async (error: any) => {
  report.status = "needs-inspection"; report.failedStage = stage;
  report.code = typeof error?.message === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(error.message) ? error.message : "SCOPED_RUN_FAILED";
  console.error(JSON.stringify({ event: "LIVE_BLOCKED", stage, code: report.code })); process.exitCode = 1;
}).finally(async () => {
  const keepBrowserForReview=!!(nativeMouse && terminal && report.outcome?.code==="GNC.ACCESS_CHALLENGE" && laneSession);
  if (handle) {
    try {
      // Cancel only this owned Workflow on harness failure; do not leave queued work orphaned.
      if (!terminal) { await handle.cancel(); report.cancelRequested = true; }
      await privateJson("history.json", await handle.fetchHistory());
    } catch { report.historyInspectionRequired = true; }
  }
  if(laneSession) {
    try {
      if(keepBrowserForReview) {
        await laneSession.stopCaptureWorkers();
        report.browserReview={status:"waiting-for-user",sessionId:laneSession.grant.sessionId,browserPid:laneSession.browser.pid,
          browser:laneSession.browser.config,releaseFile:join(root!,"release-browser.json"),automaticClose:false};
      } else {await laneSession.closeAll(); report.laneProcessesStopped=true;}
    }
    catch { report.laneCleanupRequiresInspection=true; }
    // Inspect, never free a planned-but-unstarted file or unknown process merely because the harness failed.
    try {
      const host=await miniDefaultClash();
      const state=JSON.parse(await readFile(join(host.stateRoot,"state.json"),"utf8"));
      report.laneReleased=state.state.leases.find((l:any)=>l.sessionId===laneSession!.grant.sessionId)?.closed===true;
      if(!report.laneReleased && !keepBrowserForReview)report.laneCleanupRequiresInspection=true;
    } catch {report.laneCleanupRequiresInspection=true;}
  }
  for (const { child, role } of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try { await until(async () => child.exitCode !== null || child.signalCode !== null, 25000); }
    catch { child.kill("SIGKILL"); report.forcedStops = [...(report.forcedStops ?? []), role]; }
  }
  if (db) {
    try { await privateJson("database-evidence.json", { reviews: (await db.query("SELECT record FROM review_record")).rows,
      results: (await db.query("SELECT record FROM processing_result")).rows, products: (await db.query("SELECT record FROM collected_product")).rows }); }
    catch { report.databaseInspectionRequired = true; }
    await db.end();
  }
  if (containerStarted) {
    try { await exec("docker", ["stop", "--time", "15", container], { timeout: 25000 }); report.databaseStoppedRetained = true; }
    catch { report.databaseStopRequired = true; }
  }
  await connection?.close(); report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, stage, root, outcome: report.outcome, workers: report.workers.length, namespace }));
  if(keepBrowserForReview) {
    console.log(JSON.stringify({event:"BROWSER_REVIEW_RETAINED",root,...report.browserReview}));
    // Business processes, DB and Temporal connection are already stopped. Only
    // this lightweight owner remains, retaining the profile/lane for inspection.
    let released=false;
    const requestRelease=()=>{released=true;};
    process.once("SIGINT",requestRelease);process.once("SIGTERM",requestRelease);
    try {
      while(!released) {
        try {
          const request=JSON.parse(await readFile(join(root!,"release-browser.json"),"utf8"));
          released=request.release===true && request.sessionId===laneSession!.grant.sessionId;
        } catch(e) {
          if((e as NodeJS.ErrnoException).code!=="ENOENT") {
            report.browserReview.releaseRequestInvalid=true;await save();
          }
        }
        if(!released)await new Promise(r=>setTimeout(r,1000));
      }
      await laneSession!.closeAll();report.laneProcessesStopped=true;report.laneReleased=true;
      report.browserReview.status="closed-by-explicit-release";report.browserReview.closedAt=new Date().toISOString();
      await save();
    } finally {process.removeListener("SIGINT",requestRelease);process.removeListener("SIGTERM",requestRelease);}
  }
});
