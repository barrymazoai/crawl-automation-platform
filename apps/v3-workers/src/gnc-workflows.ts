import { proxyActivities, isCancellation, ApplicationFailure, executeChild, workflowInfo } from "@temporalio/workflow";
import { GncWorkflowInputSchema, GncAcquireOutcomeSchema, GNC_QUEUES,
  type GncAcquireInput, type GncAcquireOutcome } from "@crawl-automation/v3-contracts";
import { GncProductWorkflowInputSchema, GncProductPrepareOutcomeSchema, SavedProductWorkflowInputSchema, ProductWorkflowOutcomeSchema,
  GNC_PRODUCT_QUEUES, GNC_DISCOVERY_QUEUE, GncDiscoveryOutcomeSchema, imageActivityOptions } from "@crawl-automation/v3-contracts";

/** One authorized page, not an entire Brand. Each result is durable before the next activity.
 * A catalog/product consumer may read published entries while later entries are still pending.
 * Cross-page traversal, family expansion and product admission belong to CatalogWorkflow.
 */
export async function GncCatalogPageWorkflow(raw: unknown) {
  const { task } = GncWorkflowInputSchema.parse(raw);
  if (task.capture.kind !== "catalog-page") throw ApplicationFailure.nonRetryable("Catalog page required", "GNC.INVALID_INPUT");
  const receipt = GncAcquireOutcomeSchema.parse(await executeChild("GncCaptureWorkflow", {
    workflowId: `${workflowInfo().workflowId}-capture`, taskQueue: GNC_QUEUES.workflow,
    args: [{ task }], retry: { maximumAttempts: 1 } }));
  if (receipt.operationId !== task.capture.operationId) throw ApplicationFailure.nonRetryable("Wrong capture", "GNC.IDENTITY_CONFLICT");
  if (receipt.status === "review") return receipt;
  const publish = proxyActivities<{ publishGncDiscovery(input: unknown): Promise<unknown> }>(imageActivityOptions(GNC_DISCOVERY_QUEUE));
  let total = 1, published = 0, reviewed = 0;
  const reviews: { reviewId: string; code: string; index: number }[] = [];
  for (let index = 0; index < total; index++) {
    const result = GncDiscoveryOutcomeSchema.parse(await publish.publishGncDiscovery({ task, index }));
    if (result.index !== index || result.input.index !== index || JSON.stringify(result.input.task) !== JSON.stringify(task) ||
      index > 0 && result.total !== null && result.total !== total)
      throw ApplicationFailure.nonRetryable("Wrong discovery", "GNC.IDENTITY_CONFLICT");
    if (result.total !== null) total = result.total;
    if (result.status === "published") published++;
    else { reviewed++; reviews.push({ index, reviewId: result.reviewId, code: result.code }); }
  }
  return { status: reviewed ? "review" : "page-published", published, reviewed, reviews,
    brandComplete: false, automaticRetry: false };
}

/** New entry/queue: existing capture-only workflows remain unchanged. Child processing owns its independent sources. */
export async function GncProductWorkflow(raw: unknown) {
  const { input, queues } = GncProductWorkflowInputSchema.parse(raw), parent = workflowInfo().workflowId;
  const receipt = GncAcquireOutcomeSchema.parse(await executeChild("GncCaptureWorkflow", {
    workflowId: `${parent}-capture`, taskQueue: GNC_QUEUES.workflow, args: [{ task: input.task }], retry: { maximumAttempts: 1 } }));
  if (receipt.operationId !== input.task.capture.operationId) throw ApplicationFailure.nonRetryable("Wrong capture", "GNC.IDENTITY_CONFLICT");
  if (receipt.status === "review") return { status: "review", reviewId: receipt.reviewId, codes: [receipt.code], evidenceKey: receipt.evidenceKey, automaticRetry: false };
  const prepare = proxyActivities<{ prepareGncProduct(input: unknown): Promise<unknown> }>(imageActivityOptions(GNC_PRODUCT_QUEUES.prepare));
  const planned = GncProductPrepareOutcomeSchema.parse(await prepare.prepareGncProduct({ input, receipt }));
  if (planned.operationId !== input.operationId) throw ApplicationFailure.nonRetryable("Wrong product plan", "GNC.IDENTITY_CONFLICT");
  if (planned.status === "review") return { status: "review", reviewId: planned.reviewId, codes: [planned.code], evidenceKey: planned.evidenceKey, automaticRetry: false };
  if (planned.manifest.operationId !== input.operationId || JSON.stringify(planned.manifest.observation) !== JSON.stringify(input.task.owner) ||
    planned.evidenceKey !== `v3/gnc-products/${input.operationId}/plan.json` || planned.manifest.sources.some(s => !["page", "file-image"].includes(s.kind)))
    throw ApplicationFailure.nonRetryable("Wrong sources", "GNC.IDENTITY_CONFLICT");
  for (const source of planned.manifest.sources) {
    if (source.kind === "page" && (JSON.stringify(source.plan.text) !== JSON.stringify(input.text) ||
      source.plan.page.page.producer.module !== "gnc.product-input" || source.plan.page.page.objectKey !== `v3/gnc-products/${input.operationId}/product.html`))
      throw ApplicationFailure.nonRetryable("Wrong page profile", "GNC.IDENTITY_CONFLICT");
    if (source.kind === "file-image" && (JSON.stringify(source.plan.ocr) !== JSON.stringify(input.ocr) || source.configFingerprint !== input.visionConfigFingerprint ||
      JSON.stringify(source.plan.acquire.binding) !== JSON.stringify(input.task.capture.binding)))
      throw ApplicationFailure.nonRetryable("Wrong image profile", "GNC.IDENTITY_CONFLICT");
  }
  const child = SavedProductWorkflowInputSchema.parse({ manifest: planned.manifest, queues });
  const result = ProductWorkflowOutcomeSchema.parse(await executeChild("SavedProductWorkflow", {
    workflowId: `${parent}-process`, taskQueue: GNC_PRODUCT_QUEUES.saved, args: [child], retry: { maximumAttempts: 1 } }));
  if (result.status === "collected" && (result.operationId !== input.operationId || result.observationId !== input.task.owner.observationId))
    throw ApplicationFailure.nonRetryable("Wrong collected product", "GNC.IDENTITY_CONFLICT");
  return result;
}

/** One catalog page or one SKU. Does not claim a completed Brand or downstream product processing. */
export async function GncCaptureWorkflow(raw: unknown): Promise<GncAcquireOutcome> {
  const parsed = GncWorkflowInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid GNC plan", "GNC.INVALID_INPUT");
  const { task } = parsed.data;
  const options = { startToCloseTimeout: "5 minutes", scheduleToCloseTimeout: "24 hours", heartbeatTimeout: "15 seconds",
    retry: { maximumAttempts: 1 } } as const;
  const catalog = proxyActivities<{ captureGncCatalog(task: GncAcquireInput): Promise<unknown> }>({ ...options, taskQueue: GNC_QUEUES.catalog });
  const product = proxyActivities<{ captureGncProduct(task: GncAcquireInput): Promise<unknown> }>({ ...options, taskQueue: GNC_QUEUES.product });
  const receipts = proxyActivities<{ resolveGncReceipt(input: { task: GncAcquireInput; receipt: GncAcquireOutcome | null }): Promise<unknown> }>({ ...options, taskQueue: GNC_QUEUES.receipt });
  let receipt: GncAcquireOutcome | null = null;
  try {
    const result = task.capture.kind === "catalog-page" ? await catalog.captureGncCatalog(task) : await product.captureGncProduct(task);
    receipt = GncAcquireOutcomeSchema.parse(result);
  } catch (error) { if (isCancellation(error)) throw error; /* No second capture: independently inspect existing evidence. */ }
  const result = GncAcquireOutcomeSchema.safeParse(await receipts.resolveGncReceipt({ task, receipt }));
  if (!result.success || result.data.operationId !== task.capture.operationId) throw ApplicationFailure.nonRetryable("Invalid GNC receipt", "GNC.INVALID_RECEIPT");
  return result.data;
}
