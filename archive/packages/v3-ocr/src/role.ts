import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { OcrActivityOutcomeSchema } from "@crawl-automation/v3-contracts";
import type { RoleDefinition, WorkerConfig } from "@crawl-automation/v3-worker-runtime";
import { OcrFileModule, type OcrDependencies } from "./module.js";

/** Composition root injects clients/config; no process-global service locator. */
export function createOcrRole(options: {
  buildId: string; compatibility: string; testOnly: boolean;
  prepare(config: Readonly<WorkerConfig>, signal: AbortSignal): Promise<{ dependencies: OcrDependencies; dispose(): Promise<void> }>;
}): RoleDefinition {
  return { role: "ocr-file", capability: "ocr.file", kind: "activity", contractVersion: 1,
    buildId: options.buildId, compatibility: options.compatibility, testOnly: options.testOnly,
    prepare: async (config, signal) => {
      const prepared = await options.prepare(config, signal), module = new OcrFileModule(prepared.dependencies);
      return { kind: "activity", dispose: prepared.dispose, activities: {
        ocrFile: async (...args: unknown[]) => {
          const context = Context.current();
          if (args.length !== 1 || context.info.attempt !== 1)
            throw ApplicationFailure.nonRetryable("OCR automatic retry/input rejected", "OCR.AUTOMATIC_RETRY_DENIED");
          const pulse = setInterval(() => context.heartbeat(), 2000);
          try {
            return OcrActivityOutcomeSchema.parse(await module.run(args[0], context.cancellationSignal));
          } catch {
            // No raw provider errors, text, file paths or credentials in Temporal history/logs.
            throw ApplicationFailure.nonRetryable("OCR unresolved; inspect retained evidence", "OCR.UNRESOLVED");
          } finally { clearInterval(pulse); }
        },
      } };
    },
  };
}
