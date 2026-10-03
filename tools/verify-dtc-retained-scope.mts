/** CRAWLV3-181: bounded Mini-only acceptance, original bytes only, no browser or business retry. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  connectTemporal, createR2Objects, createDatabase, createLogger, currentPermitExecution,
  LocalObjectStore, RetainedPublication, sha256,
} from "../packages/platform/src/index.js";
import { runWorker } from "../packages/platform/src/temporal-worker/index.js";
import { configurePermitActivityLedger } from "../packages/app/src/index.js";
import { PostgresPermitExecutions } from "../packages/adapters/src/index.js";
import { WorkerConfigSchema } from "../apps/worker/src/config.js";
import { guarded } from "../apps/worker/src/activities/activity-guard.js";
import { dtcProductScope } from "../apps/worker/src/browser/dtc-product-scope.js";
import { ProductPipelineInputSchema } from "../packages/workflows/src/pipeline-model.js";
import { CaptureFileSchema, captureFile, captureOutputFiles } from "../packages/channels/dtc/src/agent/archive.js";
import { readCapturedProduct } from "../packages/channels/dtc/src/agent/product-record.js";
import { verifyRetainedScopeBoundary } from "./verify-dtc-scope-boundary.mjs";
import { processDtcRetainedSingle } from "./process-dtc-retained-single.mjs";
import { DtcProductScope, type ProductScopeInput } from "../packages/channels/dtc/src/agent/product-scope.js";

const [configPath, casesPath, output, action, previousScope] = process.argv.slice(2);
if (!configPath || !casesPath || !output) throw new Error("Usage: <worker-config> <cases.json> <new-output-dir>");
if (action && action !== "--process-single") throw new Error("Unknown explicit action");
if (previousScope && action !== "--process-single") throw new Error("Scope reuse requires explicit single-case processing");
await mkdir(output, { mode: 0o700 }); // Existing output is never retried.
const write = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2), { flag: "wx" });
const cases: { runId: string; workspace: string; expected: string }[] = JSON.parse(await readFile(casesPath, "utf8"));
if (cases.length < 1 || cases.length > 3) throw new Error("Acceptance requires 1–3 explicit retained cases");
if (action && cases.length !== 1) throw new Error("Downstream acceptance processes exactly one retained case");
const config = WorkerConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const log = createLogger({ name: "dtc-scope-acceptance" });
const database = createDatabase(config.database, log);
configurePermitActivityLedger(new PostgresPermitExecutions(database));
const r2 = createR2Objects(config.storage.r2, config.storage.r2Credentials);
const temporal = await connectTemporal(config.temporal);
const publication = new RetainedPublication(await LocalObjectStore.open(join(output, "publications")), r2.store);
const scope = dtcProductScope({ config, publication });
const taskQueue = `dtc-scope-acceptance-${randomUUID()}`;
const requireWorker = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { bundleWorkflowCode, Worker } = requireWorker("@temporalio/worker");
const productionBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../packages/workflows/src/workflows.ts", import.meta.url)) });
const { code } = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../packages/workflows/src/testing/dtc-scope-acceptance.ts", import.meta.url)) });
const bundlePath = join(output, "workflows.cjs");
await writeFile(bundlePath, code, { flag: "wx" });
const worker = await runWorker(config.temporal, {
  taskQueue, workflowBundlePath: bundlePath, maxConcurrentActivities: 1,
  activities: { reviewScope: guarded("reviewScope", async (raw, signal) => {
    if (!currentPermitExecution()) throw new Error("Model execution requires an active ledger owner");
    return scope.review(raw as ProductScopeInput, signal);
  }, log) },
});
try {
  for (const [index, sample] of cases.entries()) {
    const signal = AbortSignal.timeout(300_000);
    const history = await temporal.client.workflow.getHandle(`product-run-${sample.runId}`).fetchHistory();
    await Worker.runReplayHistory({ workflowBundle: productionBundle }, history, `product-run-${sample.runId}`);
    await write(`case-${index}-replay.json`, { sourceRunId: sample.runId, replayed: true });
    const payload = history.events?.find(e => e.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
    if (!payload) throw new Error("Original workflow input missing");
    const original = ProductPipelineInputSchema.parse(JSON.parse(Buffer.from(payload).toString()));
    if (action && history.events?.some(e => e.childWorkflowExecutionStartedEventAttributes)) {
      throw new Error("Downstream child already existed; refusing a business retry");
    }
    if (original.channel !== "dtc" || original.operationId !== `product-${sample.runId}`) throw new Error("Original identity mismatch");
    const archiveKey = `v3/dtc-agent/${original.operationId}/archive.json`;
    const archive = await r2.store.read(archiveKey, 1_000_000, signal);
    if (!archive) throw new Error("Original manifest missing");
    const files = CaptureFileSchema.array().parse(JSON.parse(Buffer.from(archive).toString()).files);
    let bytesVerified = 0;
    for (let offset = 0; offset < files.length; offset += 4) {
      await Promise.all(files.slice(offset, offset + 4).map(async file => {
        const remote = await r2.store.read(file.objectKey, file.byteSize, signal);
        if (!remote) throw new Error(`Original missing: ${file.path}`);
        const local = await captureFile(sample.workspace, file.path);
        if ([remote, local].some(bytes => bytes.byteLength !== file.byteSize || sha256(bytes) !== file.sha256)) {
          throw new Error(`Original integrity mismatch: ${file.path}`);
        }
        bytesVerified += file.byteSize;
      }));
    }
    const root = join(sample.workspace, "capture");
    const captured = captureOutputFiles(files);
    const retained = await readCapturedProduct({ root, ...captured, url: original.url, requireObservedMethod: true });
    const htmlPath = typeof retained.record.pageHtml === "string" ? retained.record.pageHtml : retained.record.pageHtml.localPath;
    const source = captured.files.find(file => file.path === htmlPath);
    if (!source) throw new Error("Original HTML reference missing");
    let evidence: ProductScopeInput = {
      operationId: `dtc-scope-accept-${randomUUID()}`, url: original.url, source,
      fields: retained.record.fields, variants: retained.record.variants,
    };
    if (previousScope) {
      const previous = JSON.parse(await readFile(join(previousScope, "case-0-intent.json"), "utf8"));
      const old: ProductScopeInput = previous.evidence;
      if (previous.sample.runId !== sample.runId || old.url !== evidence.url ||
          old.source.objectKey !== source.objectKey || old.source.sha256 !== source.sha256 ||
          JSON.stringify(old.fields) !== JSON.stringify(evidence.fields) ||
          JSON.stringify(old.variants) !== JSON.stringify(evidence.variants)) throw new Error("Retained scope source mismatch");
      evidence = old;
    }
    const workflowId = evidence.operationId;
    const modelNeed = original.resources.activities["captureProduct"]?.filter(n => n.resourceId === "mini-model-account");
    if (modelNeed?.length !== 1) throw new Error("Original model permit missing");
    await write(`case-${index}-intent.json`, { workflowId, sample, archiveKey, archiveSha256: sha256(archive), files: files.length, bytesVerified, evidence });
    let result: Awaited<ReturnType<typeof scope.review>>;
    if (previousScope) {
      result = await new DtcProductScope(publication, async () => { throw new Error("Cached scope missing: model call forbidden"); }).review(evidence, signal);
      console.log(JSON.stringify({ stage: "scope-reused", index, workflowId, originalFiles: files.length, bytesVerified, modelCalls: 0 }));
    } else {
      const handle = await temporal.client.workflow.start("DtcScopeAcceptanceWorkflow", {
        workflowId, taskQueue, args: [{ resources: { queue: original.resources.queue, maxWaitSeconds: 120, activities: { reviewScope: modelNeed } }, evidence }],
        retry: { maximumAttempts: 1 },
      });
      console.log(JSON.stringify({ stage: "started", index, workflowId, originalFiles: files.length, bytesVerified }));
      result = await handle.result() as Awaited<ReturnType<typeof scope.review>>;
    }
    await write(`case-${index}-result.json`, result);
    if (result.decision.kind !== sample.expected) throw new Error(`Unexpected scope: ${result.decision.kind}`);
    const boundary = await verifyRetainedScopeBoundary({ config, original, root, captured, result });
    await write(`case-${index}-boundary.json`, boundary);
    const held = await database.query("SELECT permit_id FROM resource_permit WHERE request->>'workflowId'=$1 AND released_at IS NULL", [workflowId]);
    if (held.length) throw new Error("Acceptance left a permit held");
    console.log(JSON.stringify({ stage: "verified", index, workflowId, kind: result.decision.kind, boundary }));
    if (action === "--process-single") {
      await processDtcRetainedSingle({ config, database, publication, temporal, original, retained,
        scope: result, output, index, archiveKey, archiveSha256: sha256(archive) });
    }
  }
} finally {
  worker.shutdown();
  await worker.done;
  await temporal.close();
  r2.close();
  await database.close();
}
