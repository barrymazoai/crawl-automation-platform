import { errorCodeOf, pipelineErrors } from "@crawl-automation/platform";
import type { SiteAnalysis, SiteAnalysisResult } from "@crawl-automation/v3-contracts";
import type { SiteAnalysisStore } from "./site-analysis-service.js";

export class SiteAnalysisRunner {
  constructor(
    private readonly deps: {
      store: SiteAnalysisStore;
      analyze(
        input: SiteAnalysis,
        progress: (key: string) => Promise<void>,
        signal: AbortSignal,
      ): Promise<SiteAnalysisResult>;
    },
  ) {}

  async run(input: SiteAnalysis, signal: AbortSignal): Promise<SiteAnalysisResult> {
    await this.deps.store.running(input.analysisId);
    try {
      const result = await this.deps.analyze(
        input,
        (key) => this.deps.store.evidence(input.analysisId, key),
        signal,
      );
      await this.deps.store.finish(input.analysisId, result);
      return result;
    } catch (error) {
      await this.deps.store.finish(input.analysisId, {
        state: "failed",
        brands: [],
        archiveKeys: [],
        reasons: [errorCodeOf(error) ?? pipelineErrors.code("PIPELINE.ACTIVITY_UNRESOLVED")],
      });
      throw error;
    }
  }
}
