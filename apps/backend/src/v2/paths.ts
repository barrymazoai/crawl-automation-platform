import path from "node:path";

/**
 * v2 并行流水线的 run 内目录布局（全部相对 WORK_ROOT）：
 *
 * <runId>/v2/
 *   capture/batch-NNNNNN/   batch.json（CapturedProductBatchV1）+ products/<sku>.json（原始抓取证据）
 *   text/batch-NNNNNN/      text.json（语义 + HTML 路径 Facts）
 *   images/batch-NNNNNN/    images.json（PDF/OCR 路径 Facts）+ labels 工作目录
 *   join/batch-NNNNNN/      join.json
 *   unify/batch-NNNNNN/     unify.json
 *   finalize/               catalog.json + normalized.json + quarantine.json
 *   ingest/                 result.json
 *   review/                 需要人工处理时保留的证据
 *
 * 每个阶段目录写完后放置对应的 *.ready.json 标记（方案 5：恢复认标记，不认散文件）。
 */

export const READY = {
  capture: "capture.ready.json",
  text: "text.ready.json",
  images: "images.ready.json",
  join: "join.ready.json",
  unify: "unify.ready.json",
  finalize: "finalize.ready.json",
} as const;

export function runRoot(workRoot: string, runId: string) {
  return path.resolve(workRoot, runId, "v2");
}

export function batchDirectory(workRoot: string, runId: string, stage: "capture" | "text" | "images" | "join" | "unify", batchId: string) {
  return path.join(runRoot(workRoot, runId), stage, batchId);
}

/** registerCaptureBatch 的 batchDirectory 字段存相对 WORK_ROOT 的路径，避免绑定单机绝对路径。 */
export function relativeBatchDirectory(runId: string, batchId: string) {
  return path.join(runId, "v2", "capture", batchId);
}

export function batchIdFor(ordinal: number) {
  return `batch-${String(ordinal).padStart(6, "0")}`;
}
