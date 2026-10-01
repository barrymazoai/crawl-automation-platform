import { PostgresEnrichmentRepository } from "@crawl-automation/adapters";
import { EnrichmentService, EnrichmentTitleReader, formulaFamilies } from "@crawl-automation/app";
import { ArtifactResolver } from "@crawl-automation/platform";
import { enrichmentErrors, CodexTextModel } from "@crawl-automation/processing";
import { EnrichmentRequestSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";
import { measuredProvider } from "@crawl-automation/platform";

function service(
  parts: WorkerParts,
  model: ConstructorParameters<typeof EnrichmentService>[0]["model"],
) {
  return new EnrichmentService({
    titles: new EnrichmentTitleReader(
      parts.registry,
      new ArtifactResolver(parts.copies, parts.r2.store),
    ),
    repository: new PostgresEnrichmentRepository(parts.database, formulaFamilies(parts.registry)),
    publication: parts.publication,
    remote: parts.r2.store,
    reviews: parts.reviewLedger,
    model,
  });
}

/** The model role uses the same owned-process app-server text client and configuration as labels. */
export function enrichmentModelActivities(parts: WorkerParts) {
  return {
    enrichCollectedProduct: guarded(
      "enrichCollectedProduct",
      async (raw, signal) => {
        const input = EnrichmentRequestSchema.parse(raw);
        const config = parts.config.processing?.codex?.text;
        if (!config) {
          throw enrichmentErrors.create("ENRICH.SETTINGS_MISSING");
        }
        const model = measuredProvider(
          await CodexTextModel.open(config, process.env),
          "interpret",
          "model-enrichment",
        );
        try {
          return await service(parts, model).run(input, signal);
        } finally {
          await model.close();
        }
      },
      parts.log,
    ),
  };
}

const ReviewSchema = z.strictObject({
  input: EnrichmentRequestSchema,
  code: z.string().nullable(),
});

/** Routing and failure recording need storage but never open a model client. */
export function enrichmentPipelineActivities(parts: WorkerParts) {
  const prepare = async () => {
    const settings = parts.config.label?.shared;
    const resources = settings?.resources;
    const needs = resources?.activities["interpretText"];
    if (!settings || !resources || !needs?.length) {
      throw enrichmentErrors.create("ENRICH.SETTINGS_MISSING");
    }
    return {
      queue: settings.queues.model,
      resources: { ...resources, activities: { enrichCollectedProduct: needs } },
    };
  };
  const review = async (raw: unknown) => {
    const { input, code } = ReviewSchema.parse(raw);
    const error = enrichmentErrors.create("ENRICH.UNCLASSIFIED", { details: { causeCode: code } });
    const model = {
      provider: "not-called/1",
      interpret: async (): Promise<string> => {
        throw error;
      },
    };
    return service(parts, model).review(input, error);
  };
  return {
    prepareProductEnrichment: guarded("prepareProductEnrichment", prepare, parts.log),
    reviewProductEnrichment: guarded("reviewProductEnrichment", review, parts.log),
  };
}
