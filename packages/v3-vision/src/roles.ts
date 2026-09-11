import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import { ExecutionIdSchema, ObjectKeySchema, VisionTaskSchema, KeywordReceiptSchema, type KeywordResult } from "@crawl-automation/v3-contracts";
import type { RoleDefinition, WorkerConfig } from "@crawl-automation/v3-worker-runtime";
import { VisionModule, type VisionDependencies, type VisionOutcome } from "./module.js";
import type { RegisteredOcrEvidence } from "./ocr-evidence.js";
import type { VisionHandoff } from "./handoff.js";
type Base = { buildId: string; compatibility: string; testOnly: boolean };
type Prepared = { dispose(): Promise<void> };
const receipt = z.strictObject({ evidenceKey: ObjectKeySchema });
const reviewReceipt = z.strictObject({ reviewId: ExecutionIdSchema });
/** These factories require durable publication/review adapters; no production defaults or implicit registration. */
export function createKeywordRole(options: Base & {
  prepare(config: Readonly<WorkerConfig>, signal: AbortSignal): Promise<Prepared & {
    evidence: Pick<RegisteredOcrEvidence, "screen">;
    publish(result: KeywordResult, signal: AbortSignal): Promise<z.infer<typeof receipt>>;
    recordReview(registration: unknown, code: string, signal: AbortSignal): Promise<z.infer<typeof reviewReceipt>>;
  }>;
}): RoleDefinition {
  return { ...options, role: "ocr-keywords", capability: "ocr.keywords", kind: "activity", contractVersion: 1,
    async prepare(config, signal) {
      const p = await options.prepare(config, signal);
      return { kind: "activity", dispose: () => p.dispose(), activities: {
        screenImageKeywords: guarded("SCREEN", async (raw, signal) => {
          try {
            const result = await p.evidence.screen(raw, signal);
            const saved = receipt.parse(await p.publish(result, signal));
            return KeywordReceiptSchema.parse({ status: result.status, imageId: result.image.artifactId, selection: result, ...saved });
          } catch (error) {
            const allowed = ["SCREEN.UPSTREAM_UNVERIFIED", "SCREEN.SOURCE_CONFLICT", "SCREEN.EVIDENCE_MISMATCH", "SCREEN.PUBLICATION_CONFLICT", "SCREEN.HANDOFF_PENDING"];
            const code = error instanceof Error && allowed.includes(error.message) ? error.message : "SCREEN.EVIDENCE_UNRESOLVED";
            const saved = reviewReceipt.parse(await p.recordReview(raw, code, AbortSignal.timeout(10000)));
            return { status: "review", code, automaticRetry: false, ...saved };
          }
        }),
      } };
    },
  };
}
export function createVisionRole(options: Base & {
  prepare(config: Readonly<WorkerConfig>, signal: AbortSignal): Promise<Prepared & {
    dependencies: VisionDependencies;
    handoff: Pick<VisionHandoff, "inspect" | "complete">;
    recordReview(input: unknown, outcome: VisionOutcome, signal: AbortSignal): Promise<z.infer<typeof reviewReceipt>>;
  }>;
}): RoleDefinition {
  return { ...options, role: "codex-vision", capability: "codex.vision", kind: "activity", contractVersion: 1,
    async prepare(config, signal) {
      const p = await options.prepare(config, signal), module = new VisionModule(p.dependencies);
      return { kind: "activity", dispose: () => p.dispose(), activities: {
        interpretImage: guarded("VISION", async (raw, signal) => {
          const task = VisionTaskSchema.parse(raw), input = task.input;
          let result: VisionOutcome;
          const pending = (code: string): VisionOutcome => ({ status: "review", code, candidate: null,
            evidenceKey: `v3/vision/${input.operationId}/intent.json`, replayed: false, automaticRetry: false });
          try {
            if (task.configFingerprint !== p.dependencies.provider.fingerprint) result = pending("VISION.CONFIG_MISMATCH");
            else {
              const saved = await p.handoff.inspect(task, signal);
              if (saved) return { status: "registered", candidateStatus: saved.status, operationId: input.operationId,
                evidenceKey: saved.result.objectKey };
              result = await module.run(input, signal);
              if (result.status !== "review") {
                // Redelivery cannot silently retry publication/registration after an uncertain handoff.
                if (result.replayed) result = { ...result, status: "review", code: "VISION.HANDOFF_PENDING" };
                else {
                  try {
                    const record = await p.handoff.complete(task, signal);
                    return { status: "registered", candidateStatus: record.status, operationId: input.operationId,
                      evidenceKey: record.result.objectKey };
                  } catch { result = { ...result, status: "review", code: "VISION.HANDOFF_PENDING" }; }
                }
              }
            }
          } catch { result = pending("VISION.EVIDENCE_UNRESOLVED"); }
          if (result.status === "review") {
            const saved = reviewReceipt.parse(await p.recordReview(task, result, AbortSignal.timeout(10000)));
            return { status: "review", code: result.code, automaticRetry: false, ...saved };
          }
          throw Error("VISION.UNRESOLVED");
        }),
      } };
    },
  };
}
function guarded(stage: string, fn: (raw: unknown, signal: AbortSignal) => Promise<unknown>) {
  return async (...args: unknown[]) => {
    const ctx = Context.current();
    if (args.length !== 1 || ctx.info.attempt !== 1) throw ApplicationFailure.nonRetryable("Automatic retry rejected", `${stage}.RETRY_DENIED`);
    const timer = setInterval(() => ctx.heartbeat(), 2000);
    try { return await fn(args[0], ctx.cancellationSignal); }
    catch { throw ApplicationFailure.nonRetryable("Inspect retained module evidence", `${stage}.UNRESOLVED`); }
    finally { clearInterval(timer); }
  };
}
