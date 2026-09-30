import {
  appErrors,
  EvidenceCaptureInputSchema,
  EvidenceCaptureResultSchema,
  EvidenceOriginalInputSchema,
  type EvidenceService,
} from "@crawl-automation/app";
import { procedure, router } from "../trpc.js";

/** Optional during API wiring: missing injection is a registered refusal, never a runtime TypeError. */
declare module "../trpc.js" {
  interface ApiContext {
    evidence?: Pick<EvidenceService, "capture">;
  }
}

export const evidenceRouter = router({
  original: procedure
    .input(EvidenceOriginalInputSchema)
    .query(({ ctx, input }) => ctx.originals.original(input)),

  capture: procedure
    .input(EvidenceCaptureInputSchema)
    .output(EvidenceCaptureResultSchema)
    .mutation(({ ctx, input }) => {
      if (!ctx.evidence) {
        throw appErrors.create("EVIDENCE.NOT_CONFIGURED");
      }
      return ctx.evidence.capture(input);
    }),
});
