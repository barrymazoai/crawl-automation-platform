import { z } from "zod";
import {
  SiteUrlSchema,
  type SiteAnalysis,
  type SiteAnalysisLimits,
  type SiteAnalysisResult,
} from "@crawl-automation/v3-contracts";
import { siteAnalysisErrors } from "./errors.js";

export const AnalyzeSiteSchema = z.strictObject({ requestId: z.uuid(), url: SiteUrlSchema });
export const ApplySiteAnalysisSchema = z.strictObject({
  requestId: z.uuid(),
  analysisId: z.uuid(),
  brands: z.array(z.string().trim().min(1)).min(1).max(500).optional(),
});
export const SiteAnalysisApplyResultSchema = z.object({
  created: z.array(z.object({ name: z.string(), brandId: z.uuid(), sourceId: z.uuid() })),
  matched: z.array(z.object({ name: z.string(), brandId: z.uuid(), sourceId: z.uuid() })),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type SiteAnalysisApplyResult = z.infer<typeof SiteAnalysisApplyResultSchema>;
export interface SiteAnalysisStore {
  create(
    input: z.infer<typeof AnalyzeSiteSchema>,
    limits: SiteAnalysisLimits,
  ): Promise<SiteAnalysis>;
  get(analysisId: string): Promise<SiteAnalysis | null>;
  running(analysisId: string): Promise<void>;
  evidence(analysisId: string, key: string): Promise<void>;
  finish(analysisId: string, result: SiteAnalysisResult): Promise<void>;
  apply(input: z.infer<typeof ApplySiteAnalysisSchema>): Promise<SiteAnalysisApplyResult>;
}
export interface SiteAnalysisGateway {
  start(analysis: SiteAnalysis): Promise<void>;
  failure(analysisId: string): Promise<string | null>;
}

export class SiteAnalysisService {
  constructor(
    private readonly deps: {
      store: SiteAnalysisStore;
      gateway: SiteAnalysisGateway;
      limits: SiteAnalysisLimits;
    },
  ) {}

  async analyze(raw: unknown) {
    const input = AnalyzeSiteSchema.parse(raw);
    const analysis = await this.deps.store.create(input, this.deps.limits);
    await this.deps.gateway.start(analysis);
    return { analysisId: analysis.analysisId };
  }

  async get(analysisId: string): Promise<SiteAnalysis> {
    const analysis = await this.deps.store.get(analysisId);
    if (!analysis) {
      throw siteAnalysisErrors.create("SITE_ANALYSIS.NOT_FOUND");
    }
    if (analysis.state === "queued" || analysis.state === "running") {
      const failure = await this.deps.gateway.failure(analysisId);
      if (failure) {
        const result = { ...analysis, state: "failed" as const, reasons: [failure] };
        await this.deps.store.finish(analysisId, result);
        return result;
      }
    }
    return analysis;
  }

  async apply(raw: unknown): Promise<SiteAnalysisApplyResult> {
    const input = ApplySiteAnalysisSchema.parse(raw);
    const analysis = await this.get(input.analysisId);
    if (analysis.state !== "completed") {
      throw siteAnalysisErrors.create("SITE_ANALYSIS.NOT_APPLICABLE", {
        details: { state: analysis.state },
      });
    }
    return this.deps.store.apply(input);
  }
}
