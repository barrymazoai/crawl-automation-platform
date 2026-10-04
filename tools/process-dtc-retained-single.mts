/** Explicit downstream execution from retained capture under a recorded purpose; never recaptures. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PostgresSiteAnalyses } from "../packages/adapters/src/index.js";
import { ProductSourcePlans } from "../packages/channels/core/src/index.js";
import { configuredDtcSites, storedDtcSites } from "../packages/channels/dtc/src/index.js";
import { siteForUrl } from "../packages/channels/dtc/src/address.js";
import { createDtcAdapter } from "../packages/channels/dtc/src/adapter.js";
import { capturedProductProjection } from "../packages/channels/dtc/src/agent/product-projection.js";
import { DtcVariantHandoffSchema } from "../packages/v3-contracts/src/index.js";
import type { readCapturedProduct } from "../packages/channels/dtc/src/agent/product-record.js";
import type { WorkerConfig } from "../apps/worker/src/config.js";
import type { ProductPipelineInput } from "../packages/workflows/src/pipeline-model.js";
import type { Database, RetainedPublication, TemporalClient } from "../packages/platform/src/index.js";
import type { DtcProductScope } from "../packages/channels/dtc/src/agent/product-scope.js";

export async function processDtcRetainedSingle(at: {
  config: WorkerConfig; database: Database; publication: RetainedPublication;
  temporal: TemporalClient; original: ProductPipelineInput;
  retained: Awaited<ReturnType<typeof readCapturedProduct>>;
  scope: Awaited<ReturnType<DtcProductScope["review"]>>;
  output: string; index: number; archiveKey: string; archiveSha256: string;
  purpose?: string;
  preserveCaptureIdentity?: boolean;
}) {
  if (!at.config.browser || !at.config.plan || at.scope.decision.kind !== "single_product" ||
      at.retained.record.variants.length !== 1) throw new Error("Requires verified scope and exactly one website variant");
  const { publication, original, retained } = at;
  const operationId = `dtc-retained-${randomUUID()}`;
  const only = retained.record.variants[0];
  if (!only?.variantId || !only.url) throw new Error("Observed website variant identity missing");
  const input = { ...original, runId: randomUUID(), operationId,
    url: at.preserveCaptureIdentity ? original.url : only.url };
  const sites = storedDtcSites(configuredDtcSites(at.config.browser.dtc), await new PostgresSiteAnalyses(at.database).settings());
  const site = siteForUrl(input.url, sites);
  const adapter = createDtcAdapter(sites, original.sourceUrl);
  if (!adapter.planning) throw new Error("DTC source planning unavailable");
  const planning = { ...adapter.planning, parserVersion: "dtc-agent/1" as const };
  const parsed = capturedProductProjection({ ...retained, site, url: input.url, sourceUrl: original.sourceUrl });
  // A retained base-product capture keeps its base owner. Website variants remain unchanged
  // in the projection; this descriptor identifies only the downstream execution target.
  const variant = at.preserveCaptureIdentity && parsed.identity.variantId === null
    ? { ...parsed.identity, url: input.url, title: parsed.evidence.title }
    : parsed.evidence.variants[0];
  if (!variant || variant.variantId !== parsed.identity.variantId || variant.url !== input.url ||
      parsed.evidence.imageCandidates.some(image => image.variantId !== parsed.identity.variantId)) {
    throw new Error("Single product material ownership mismatch");
  }
  const prefix = `v3/dtc-agent/${operationId}`;
  const signal = AbortSignal.timeout(60_000);
  const provenance = {
    purpose: at.purpose ?? "First downstream processing from already-archived native capture; no new website observation",
    sourceRunId: original.runId, sourceOperationId: original.operationId,
    sourceArchive: { objectKey: at.archiveKey, sha256: at.archiveSha256 },
    originalHtmlPath: retained.record.pageHtml, scope: at.scope.evidence, derivedAt: new Date().toISOString(),
    downstreamOwner: parsed.identity, sourceUrl: original.url,
  };
  await publication.publish(`${prefix}/retained-analysis.json`, Buffer.from(JSON.stringify(provenance)), "application/json", signal);
  await publication.publish(`${prefix}/images.json`, Buffer.from(JSON.stringify({ version: "dtc-agent-images/1", url: input.url, images: retained.images })), "application/json", signal);
  const sourcePlans = new ProductSourcePlans(publication, { ...at.config.plan, egressId: "direct/1" });
  const sourcePlan = await sourcePlans.publish(input, { parsed, planning }, signal);
  const projection = await publication.remote.read(sourcePlan.source.objectKey, sourcePlan.source.byteSize, signal);
  if (!projection) throw new Error("Retained projection publication missing");
  planning.read(JSON.parse(Buffer.from(projection).toString()), input.url, sourcePlan.owner);
  const member = DtcVariantHandoffSchema.parse({
    status: "ready", operationId, variant, evidence: retained.review.evidence,
    planned: { status: "captured", sourcePlan, factsComplete: parsed.facts.complete, labelText: parsed.facts.text, family: null },
  });
  const write = (name: string, value: unknown) => writeFile(join(at.output, `case-${at.index}-${name}.json`), JSON.stringify(value, null, 2), { flag: "wx" });
  const workflowId = `dtc-retained-single-${randomUUID()}`;
  await write("processing-intent", { workflowId, input, member, provenance });
  const handle = await at.temporal.client.workflow.start("DtcVariantWorkflow", {
    workflowId, taskQueue: input.queues.activities, args: [{ input, member }], retry: { maximumAttempts: 1 },
  });
  console.log(JSON.stringify({ stage: "processing-started", workflowId, operationId, sourceRunId: original.runId }));
  const result = await handle.result();
  await write("processing-result", result);
  console.log(JSON.stringify({ stage: "processing-finished", workflowId, result }));
}
