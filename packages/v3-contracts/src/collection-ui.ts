import { z } from "zod";
import { CollectionSubmission } from "./submissions.js";
import { DeliveryReceipt } from "./delivery.js";

// Operator configuration, never a URL supplied by a source or a Workflow result.
export const TemporalUi = z.strictObject({
  clusterId: z.string().min(1).max(100),
  baseUrl: z.url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"));
  }, "Use HTTPS or loopback HTTP, without credentials/query/fragment"),
});
export const CollectionCapabilities = z.strictObject({
  submissionIntakeEnabled: z.boolean(),
  environment: z.enum(["local-v3", "isolated-acceptance", "isolated-live"]),
  temporalUi: z.array(TemporalUi).max(20),
});
export type CollectionCapabilities = z.infer<typeof CollectionCapabilities>;
export const DeliveryReadback = z.strictObject({ item: DeliveryReceipt.nullable() });

export function temporalExecutionUrl(capabilities: CollectionCapabilities, submission: CollectionSubmission, receipt: DeliveryReceipt | null): string | null {
  if (!receipt || receipt.requestId !== submission.requestId || !receipt.runId || receipt.state === "START_UNKNOWN") return null;
  if (receipt.lastIssue && ["IDENTITY_MISMATCH", "RUN_CHANGED", "CHAIN_CONTINUED"].includes(receipt.lastIssue)) return null;
  const mapping = capabilities.temporalUi.find(ui => ui.clusterId === receipt.target.clusterId);
  if (!mapping) return null;
  return `${TemporalUi.parse(mapping).baseUrl.replace(/\/$/, "")}/namespaces/${encodeURIComponent(receipt.target.namespace)}/workflows/${encodeURIComponent(submission.workflowId)}/${receipt.runId}/history`;
}
