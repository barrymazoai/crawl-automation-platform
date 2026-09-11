import { isDeepStrictEqual as equal } from "node:util";
import { GncReceiptInputSchema, type GncAcquireOutcome } from "@crawl-automation/v3-contracts";
import { GncError } from "./gnc.js";
import { GncCaptureEvidence } from "./gnc-handoff.js";
/** No crawl, parsing, publication/resume or provider configuration. A receipt is a hint, never proof. */
export class ResolveGncReceipt {
  constructor(private readonly evidence: GncCaptureEvidence) {}
  async run(raw: unknown, signal: AbortSignal): Promise<GncAcquireOutcome> {
    const { task, receipt } = GncReceiptInputSchema.parse(raw), e = this.evidence;
    try {
      signal.throwIfAborted();
      if (receipt && receipt.operationId !== task.capture.operationId) throw new GncError("GNC.EVIDENCE_CONFLICT");
      if (receipt?.status === "review") {
        const prior = await e.priorReview(task);
        if (!prior || !equal(prior, receipt)) throw new GncError("GNC.REVIEW_UNVERIFIED"); return prior;
      }
      const record = await e.inspect(task, signal);
      if (record) {
        const verified = e.receipt(record);
        if (receipt && !equal(verified, receipt)) throw new GncError("GNC.EVIDENCE_CONFLICT"); return verified;
      }
      const prior = await e.priorReview(task); if (prior && !receipt) return prior;
      throw new GncError("GNC.NOT_DURABLE");
    } catch (error) {
      signal.throwIfAborted();
      return e.review(task, error, "unknown");
    }
  }
}
