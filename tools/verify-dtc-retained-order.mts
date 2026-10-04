/** Explicit new-policy validation from one retained single product; no browser or old-task retry. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  connectTemporal, createR2Objects, createDatabase, createLogger,
  LocalObjectStore, RetainedPublication, sha256,
} from "../packages/platform/src/index.js";
import { WorkerConfigSchema } from "../apps/worker/src/config.js";
import { ProductPipelineInputSchema, BrowserCaptureResultSchema } from "../packages/workflows/src/pipeline-model.js";
import { captureFile, captureOutputFiles, CaptureFileSchema } from "../packages/channels/dtc/src/agent/archive.js";
import { readCapturedProduct } from "../packages/channels/dtc/src/agent/product-record.js";
import { DtcProductScope } from "../packages/channels/dtc/src/agent/product-scope.js";
import { labelSourcePolicy } from "../packages/channels/core/src/planning/source-order.js";
import { processDtcRetainedSingle } from "./process-dtc-retained-single.mjs";

const [configPath, sourceRunId, workspace, output] = process.argv.slice(2);
if (!configPath || !sourceRunId || !workspace || !output) {
  throw new Error("Usage: <worker-config> <source-run-id> <original-workspace> <new-output-dir>");
}
await mkdir(output, { mode: 0o700 }); // A second/ambiguous execution never reuses its intent directory.
const config = WorkerConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const order = labelSourcePolicy("dtc", config.plan?.sourceOrder.dtc);
if (order.order !== "images-first") throw new Error("DTC must use the approved images-first policy");
const log = createLogger({ name: "dtc-retained-order" });
const database = createDatabase(config.database, log);
const r2 = createR2Objects(config.storage.r2, config.storage.r2Credentials);
const temporal = await connectTemporal(config.temporal);
const signal = AbortSignal.timeout(300_000);
const write = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2), { flag: "wx" });
try {
  const sourceHandle = temporal.client.workflow.getHandle(`product-run-${sourceRunId}`);
  const description = await sourceHandle.describe();
  if (description.status.name !== "COMPLETED") throw new Error("Original run must have settled");
  const history = await sourceHandle.fetchHistory();
  const events = history.events ?? [];
  const payload = events.find(e => e.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
  if (!payload) throw new Error("Original workflow input missing");
  const original = ProductPipelineInputSchema.parse(JSON.parse(Buffer.from(payload).toString()));
  if (original.channel !== "dtc" || original.operationId !== `product-${sourceRunId}`) throw new Error("Original identity mismatch");
  const scheduled = events.find(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "captureBrowserProduct");
  const completed = events.find(e => e.activityTaskCompletedEventAttributes &&
    String(e.activityTaskCompletedEventAttributes.scheduledEventId) === String(scheduled?.eventId));
  const result = completed?.activityTaskCompletedEventAttributes?.result?.payloads?.[0]?.data;
  if (!result) throw new Error("Retained successful capture missing");
  const captured = BrowserCaptureResultSchema.parse(JSON.parse(Buffer.from(result).toString()));
  if (captured.status !== "captured" || !captured.planned || captured.variants) throw new Error("Requires original single-product handoff");
  if (captured.planned.sourcePlan.sourcePolicy?.order !== "text-first") throw new Error("Requires the old text-first case");
  const archiveKey = `v3/dtc-agent/${original.operationId}/archive.json`;
  const archive = await r2.store.read(archiveKey, 1_000_000, signal);
  if (!archive) throw new Error("Original archive missing");
  const files = CaptureFileSchema.array().parse(JSON.parse(Buffer.from(archive).toString()).files);
  let bytesVerified = 0;
  for (let offset = 0; offset < files.length; offset += 4) {
    await Promise.all(files.slice(offset, offset + 4).map(async file => {
      const remote = await r2.store.read(file.objectKey, file.byteSize, signal);
      if (!remote) throw new Error(`Original missing: ${file.path}`);
      const local = await captureFile(workspace, file.path);
      for (const bytes of [remote, local]) {
        if (bytes.byteLength !== file.byteSize || sha256(bytes) !== file.sha256) {
          throw new Error(`Original integrity mismatch: ${file.path}`);
        }
      }
      bytesVerified += file.byteSize;
    }));
  }
  if (!files.some(file => file.path === "capture/materials.json")) throw new Error("Requires native capture-only materials");
  const retained = await readCapturedProduct({ root: join(workspace, "capture"), ...captureOutputFiles(files),
    url: original.url, requireObservedMethod: false, captureContract: "dtc-materials/1" });
  if (retained.record.variants.length !== 1) throw new Error("Requires exactly one website variant");
  const html = await r2.store.read(captured.archiveKey, 32 * 1024 * 1024, signal);
  if (!html || html.byteLength !== retained.html.byteLength || sha256(html) !== sha256(retained.html)) {
    throw new Error("Original HTML integrity mismatch");
  }
  const publication = new RetainedPublication(await LocalObjectStore.open(join(output, "publications")), r2.store);
  const scope = await new DtcProductScope(publication, async () => {
    throw new Error("Original scope cache missing; no new model call allowed");
  }).review({ operationId: original.operationId, url: original.url,
    source: { objectKey: captured.archiveKey, sha256: sha256(html), byteSize: html.byteLength },
    fields: { ...retained.record.fields, ...(retained.detailsHtml ? { html: retained.detailsHtml } : {}) },
    variants: retained.record.variants,
  }, signal);
  const purpose = "CRAWLV3-207 user-approved DTC images-first policy validation from retained originals; old task and Review unchanged";
  await write("provenance.json", { at: new Date().toISOString(), purpose, sourceRunId,
    archiveKey, archiveSha256: sha256(archive), files: files.length, bytesVerified,
    oldPolicy: captured.planned.sourcePlan.sourcePolicy, newPolicy: order, scope: scope.evidence,
    sourceResult: await sourceHandle.result() });
  console.log(JSON.stringify({ stage: "originals-verified", sourceRunId, files: files.length, bytesVerified, order }));
  await processDtcRetainedSingle({ config, database, publication, temporal, original, retained,
    scope, output, index: 0, archiveKey, archiveSha256: sha256(archive), purpose,
    preserveCaptureIdentity: true });
} finally {
  await temporal.close();
  r2.close();
  await database.close();
}
