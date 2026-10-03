/** Manually invoked, bounded CRAWLV3-178 acceptance. Never opens a browser or changes an old Review. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  connectTemporal, createR2Objects, LocalObjectStore, RetainedPublication, sha256,
} from "../packages/platform/src/index.js";
import { ProductSourcePlans } from "../packages/channels/core/src/index.js";
import { WorkerConfigSchema } from "../apps/worker/src/config.js";
import { ProductPipelineInputSchema } from "../packages/workflows/src/pipeline-model.js";
import { DtcVariantHandoffsSchema } from "../packages/v3-contracts/src/index.js";
import { captureFile, captureOutputFiles, CaptureFileSchema } from "../packages/channels/dtc/src/agent/archive.js";
import { readCapturedProduct } from "../packages/channels/dtc/src/agent/product-record.js";
import { CaptureReviewAuthoringSchema } from "../packages/channels/dtc/src/agent/product-review.js";
import { capturedProductProjection } from "../packages/channels/dtc/src/agent/product-projection.js";
import { DtcVariantHandoffs } from "../packages/channels/dtc/src/agent/variant-handoffs.js";
import { createDtcAdapter } from "../packages/channels/dtc/src/adapter.js";
import { dtcSitePolicy } from "../packages/channels/dtc/src/site-policy.js";
import { readPreflightVariantContexts } from "../crawl-products/lib/observed-variant.mjs";

const sourceRunId = "d7ad53b4-a202-4c32-a82d-f61ba99d2f90";
const url = "https://solaray.com/products/magnesium-glycinate";
const [configPath, workspace, output, action] = process.argv.slice(2);
if (!configPath || !workspace || !output || !["--prepare", "--execute"].includes(action ?? "")) {
  throw new Error("Usage: verify-dtc-retained-mixed <worker-config> <original-workspace> <new-output-dir> --prepare|--execute");
}
// mkdir without recursive makes any ambiguous or repeated invocation stop before publication/execution.
await mkdir(output, { mode: 0o700 });
const config = WorkerConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const r2 = createR2Objects(config.storage.r2, config.storage.r2Credentials);
const temporal = await connectTemporal(config.temporal);
const signal = AbortSignal.timeout(300_000);
const write = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2), { flag: "wx" });
try {
  const history = await temporal.client.workflow.getHandle(`product-run-${sourceRunId}`).fetchHistory();
  const started = history.events?.find(e => e.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes;
  const payload = started?.input?.payloads?.[0]?.data;
  if (!payload) throw new Error("Original workflow input missing");
  const original = ProductPipelineInputSchema.parse(JSON.parse(Buffer.from(payload).toString()));
  if (original.channel !== "dtc" || original.url !== url || original.operationId !== `product-${sourceRunId}`) {
    throw new Error("Acceptance source identity mismatch");
  }
  const archiveKey = `v3/dtc-agent/${original.operationId}/archive.json`;
  const archive = await r2.store.read(archiveKey, 1_000_000, signal);
  if (!archive) throw new Error("Original archive missing");
  const files = CaptureFileSchema.array().parse(JSON.parse(Buffer.from(archive).toString()).files);
  let bytesVerified = 0;
  for (let index = 0; index < files.length; index += 4) {
    await Promise.all(files.slice(index, index + 4).map(async file => {
      const remote = await r2.store.read(file.objectKey, file.byteSize, signal);
      if (!remote) throw new Error(`Original missing: ${file.path}`);
      const local = await captureFile(workspace, file.path);
      if ([remote, local].some(bytes => bytes.byteLength !== file.byteSize || sha256(bytes) !== file.sha256)) {
        throw new Error(`Original integrity mismatch: ${file.path}`);
      }
      bytesVerified += file.byteSize;
    }));
  }
  const root = join(workspace, "capture");
  const retainedFiles = captureOutputFiles(files);
  const retained = await readCapturedProduct({ root, ...retainedFiles, url, requireObservedMethod: true });
  const review = CaptureReviewAuthoringSchema.parse({
    ...retained.review,
    variantContexts: await readPreflightVariantContexts(root),
  });
  if (retained.record.variants.length !== 2 || retained.images.length !== 5) {
    throw new Error("Bounded acceptance requires the two-variant/five-image original");
  }
  const runId = randomUUID();
  const input = ProductPipelineInputSchema.parse({ ...original, runId, operationId: `dtc-retained-${runId}` });
  const prefix = `v3/dtc-agent/${input.operationId}`;
  const cache = await LocalObjectStore.open(join(output, "publications"));
  // Preparation is offline except for reading originals; derived publications stay local without --execute.
  const publication = new RetainedPublication(cache, action === "--execute" ? r2.store : cache);
  const site = dtcSitePolicy({ siteKey: "solaray.com", platform: "shopify", catalogUrl: original.sourceUrl ?? null });
  const parsed = capturedProductProjection({ ...retained, review, site, url, sourceUrl: original.sourceUrl });
  const planning = { ...createDtcAdapter([site]).planning!, parserVersion: "dtc-agent/1" as const };
  if (!config.plan) throw new Error("Plan configuration missing");
  const sourcePlans = new ProductSourcePlans(publication, { ...config.plan, egressId: "direct/1" });
  const provenance = {
    purpose: "CRAWLV3-178 retained-original acceptance; no new website capture",
    sourceRunId, archiveKey, archiveSha256: sha256(archive), files: files.length, bytesVerified,
    runId, derivedAt: new Date().toISOString(),
    derivation: "Use the complete original preflight contexts; keep the lossy original final review unchanged",
    review,
  };
  await publication.publish(`${prefix}/retained-analysis.json`, Buffer.from(JSON.stringify(provenance)), "application/json", signal);
  await publication.publish(`${prefix}/images.json`, Buffer.from(JSON.stringify({ version: "dtc-agent-images/1", url, images: retained.images })), "application/json", signal);
  const sourcePlan = await sourcePlans.publish(input, { parsed, planning }, signal);
  const variants = await new DtcVariantHandoffs({ publication, sourcePlans }).publish({
    root, ...retainedFiles, ...retained, review, request: input, site, parsed, planning,
  }, signal);
  if (variants.some(member => member.status !== "mixed")) throw new Error(`Unexpected handoff: ${JSON.stringify(variants)}`);
  const prepared = { input, sourcePlan, variants, provenance };
  await write("prepared.json", prepared);
  console.log(JSON.stringify({ stage: "prepared", runId, originalFiles: files.length, bytesVerified, variants: variants.map(m => ({ id: m.variant.variantId, status: m.status })) }));
  if (action === "--execute") {
    const galleryWorkflowId = `dtc-gallery-accept-${runId}`;
    await write("gallery-intent.json", { runId, workflowId: galleryWorkflowId });
    const gallery = await temporal.client.workflow.start("DtcGalleryWorkflow", {
      workflowId: galleryWorkflowId, taskQueue: input.queues.activities,
      args: [{ input, sourcePlan, variants }], retry: { maximumAttempts: 1 },
    });
    console.log(JSON.stringify({ stage: "gallery-started", workflowId: galleryWorkflowId }));
    const scoped = DtcVariantHandoffsSchema.parse(await gallery.result());
    await write("gallery-result.json", scoped);
    if (scoped.some(member => member.status !== "ready")) {
      console.log(JSON.stringify({ stage: "gallery-review", result: scoped }));
    } else {
      const results = [];
      for (const [index, member] of scoped.entries()) {
        const workflowId = `dtc-variant-accept-${randomUUID()}`;
        await write(`variant-${index}-intent.json`, { workflowId, variant: member.variant });
        const child = await temporal.client.workflow.start("DtcVariantWorkflow", {
          workflowId, taskQueue: input.queues.activities,
          args: [{ input: { ...input, operationId: member.operationId, url: member.variant.url }, member }],
          retry: { maximumAttempts: 1 },
        });
        console.log(JSON.stringify({ stage: "variant-started", workflowId, variantId: member.variant.variantId }));
        const result = await child.result();
        results.push({ workflowId, variant: member.variant, result });
        await write(`variant-${index}-result.json`, result);
      }
      await write("results.json", { runId, sourceRunId, galleryWorkflowId, results });
      console.log(JSON.stringify({ stage: "finished", runId, galleryWorkflowId, results }));
    }
  }
} finally {
  r2.close();
  await temporal.close();
}
