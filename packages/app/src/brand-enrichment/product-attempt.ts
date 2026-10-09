import { createHash } from "node:crypto";

export type ProductStep =
  "product-analysis" | "product-sources" | "products" | "products-failure" | "products-retry";

/** Attempt one retains every historical step name. */
export function productStep(name: ProductStep, attempt = 1): string {
  return attempt === 1 ? name : `${name}@${attempt}`;
}

export function productAnalysisRequestId(runId: string, attempt = 1): string {
  return attempt === 1 ? runId : operationRequestId(runId, `analyze@${attempt}`);
}

/** Stable, distinct request receipts for operations within a run. */
export function operationRequestId(runId: string, operation: string): string {
  const hex = createHash("sha256").update(`${runId}:${operation}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
