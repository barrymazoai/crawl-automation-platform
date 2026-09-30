import { proxyActivities } from "@temporalio/workflow";
import type { ProductEvidenceJoin, MixedCollectionInput } from "@crawl-automation/v3-contracts";
export async function BusinessMixedCollectProbe(input: { task: MixedCollectionInput; queue: string }) {
  return proxyActivities<{ collectMixedProduct(task: MixedCollectionInput): Promise<unknown> }>(imageActivityOptions(input.queue)).collectMixedProduct(input.task);
}
export async function BusinessMixedProbe(input: { task: ProductEvidenceJoin; queue: string }) {
  return proxyActivities<{ assembleProductEvidence(task: ProductEvidenceJoin): Promise<unknown> }>(imageActivityOptions(input.queue)).assembleProductEvidence(input.task);
}
export { BusinessOcrProbe } from "./ocr-workflows.js";
import { imageActivityOptions, type VisionTask, type ProductCollectionInput, type FileAcquireInput, type PdfInput } from "@crawl-automation/v3-contracts";
export async function BusinessVisionProbe(input: { task: VisionTask; queue: string }) {
  return proxyActivities<{ interpretImage(task: VisionTask): Promise<unknown> }>(imageActivityOptions(input.queue)).interpretImage(input.task);
}
export async function BusinessCollectProbe(input: { task: ProductCollectionInput; queue: string }) {
  return proxyActivities<{ collectProduct(task: ProductCollectionInput): Promise<unknown> }>(imageActivityOptions(input.queue)).collectProduct(input.task);
}
export async function BusinessAcquireProbe(input: { task: FileAcquireInput; queue: string }) {
  return proxyActivities<{ acquireSourceFile(task: FileAcquireInput): Promise<unknown> }>(imageActivityOptions(input.queue)).acquireSourceFile(input.task);
}
export async function BusinessPdfProbe(input: { task: PdfInput; queue: string; activity: "inspectPdf" | "extractPdfPageText" | "renderPdfPage" }) {
  const activities = proxyActivities<{ inspectPdf(task: PdfInput): Promise<unknown>; extractPdfPageText(task: PdfInput): Promise<unknown>; renderPdfPage(task: PdfInput): Promise<unknown> }>(imageActivityOptions(input.queue));
  return activities[input.activity](input.task);
}
