import { parseOcrInput, type OcrInput } from "@crawl-automation/v3-contracts";
import { createHash } from "node:crypto";
import { ReviewError, type PrivateReviewReader } from "./ports.js";
export interface InspectionPorts {
    delivery?: {
        inspect(requestId: string): Promise<{
            decision: string;
            issue: string | null;
        }>;
    };
    result?: {
        inspect(input: OcrInput, signal?: AbortSignal): Promise<{
            computedLocal: boolean;
            artifactDurable: boolean;
            resultRegistered: boolean;
        }>;
    };
}
/** A read-only view, not a reconciler. No append/upload/register/start/release ports. */
export class ReviewInspector {
    constructor(private readonly records: PrivateReviewReader, private readonly ports: InspectionPorts = {}) { }
    async inspect(reviewId: string, signal?: AbortSignal) {
        const record = await this.records.read(reviewId);
        if (!record)
            throw new ReviewError("REVIEW.NOT_FOUND");
        const base = { reviewId, observedAt: new Date().toISOString(), mutatesState: false as const, automaticRetry: false as const };
        const target = record.inspection;
        if (target.kind === "none")
            return { ...base, status: "NOT_APPLICABLE" };
        if (target.kind === "workflow-delivery" && this.ports.delivery) {
            try {
                const result = await this.ports.delivery.inspect(target.requestId);
                const decisions = ["HOLD", "RECORDED_CLOSED", "READY_FOR_RECONCILIATION", "WAITING_REMOTE"];
                if (!decisions.includes(result.decision))
                    return { ...base, status: "UNAVAILABLE" };
                // Provider messages are never propagated from the adapter.
                return { ...base, status: "INSPECTED", delivery: { decision: result.decision, hasIssue: result.issue !== null } };
            }
            catch {
                return { ...base, status: "UNAVAILABLE" };
            }
        }
        if (target.kind === "ocr-result" && this.ports.result) {
            try {
                const input = parseOcrInput(target.input, text => createHash("sha256").update(text).digest("hex"));
                const result = await this.ports.result.inspect(input, signal);
                return { ...base, status: "INSPECTED", result: {
                        computedLocal: result.computedLocal, artifactDurable: result.artifactDurable, resultRegistered: result.resultRegistered,
                    } };
            }
            catch {
                return { ...base, status: "UNAVAILABLE" };
            }
        }
        return { ...base, status: "NOT_CONFIGURED" };
    }
}
