import { z } from "zod";
import {
  BrandRunIdSchema,
  CloseBrandRunSchema,
  brandEnrichmentErrors,
} from "@crawl-automation/app";
import type { WorkerParts } from "../container.js";
import type { BrandEnrichmentParts } from "../brand-enrichment-parts.js";
import { guarded } from "./activity-guard.js";
import { checkBrowserPermit } from "./browser-permit.js";

type Step = (parts: BrandEnrichmentParts, runId: string, signal: AbortSignal) => Promise<unknown>;
function step(parts: WorkerParts, name: string, handler: Step) {
  return guarded(
    name,
    async (raw, signal) =>
      handler(await parts.brandEnrichment, BrandRunIdSchema.parse(raw).runId, signal),
    parts.log,
  );
}
export function brandEnrichmentActivities(parts: WorkerParts) {
  return {
    brandIdentity: step(parts, "brandIdentity", async (services, runId, signal) => {
      await services.identity.resolve(runId, signal);
      const run = await services.runs.get(runId);
      if (!run) {
        throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_FOUND");
      }
      return { role: run.role, hasWebsite: !!run.brandUrl };
    }),
    brandProducts: step(parts, "brandProducts", (services, runId, signal) =>
      services.products.tick(runId, signal),
    ),
    brandProductsStop: step(parts, "brandProductsStop", (services, runId) =>
      services.products.stop(runId),
    ),
    brandWrite: step(parts, "brandWrite", (services, runId, signal) =>
      services.write.write(runId, signal),
    ),
    brandOwnershipWrite: step(parts, "brandOwnershipWrite", (services, runId, signal) =>
      services.ownership.write(runId, signal),
    ),
    brandClose: guarded(
      "brandClose",
      async (raw, signal) =>
        (await parts.brandEnrichment).close.close(CloseBrandRunSchema.parse(raw), signal),
      parts.log,
    ),
    brandProductFailure: guarded(
      "brandProductFailure",
      async (raw) => {
        const { runId, reason } = z.object({ runId: z.uuid(), reason: z.string() }).parse(raw);
        await (
          await parts.brandEnrichment
        ).runs.saveStep({ runId, step: "products-failure", output: { reason }, archiveKeys: [] });
      },
      parts.log,
    ),
  };
}
export function brandEnrichmentModelActivities(parts: WorkerParts) {
  if (!parts.config.brandEnrichment) {
    return {};
  }
  return {
    brandApollo: step(parts, "brandApollo", (services, runId, signal) =>
      services.apollo.match(runId, signal),
    ),
    brandContacts: step(parts, "brandContacts", (services, runId, signal) =>
      services.contacts.classify(runId, signal),
    ),
    brandReview: step(parts, "brandReview", (services, runId, signal) =>
      services.review.review(runId, signal),
    ),
  };
}
export function brandEnrichmentBrowserActivities(parts: WorkerParts) {
  if (!parts.config.brandEnrichment) {
    return {};
  }
  const browserStep = (name: string, handler: Step) =>
    guarded(
      name,
      {
        beforePermit: () => checkBrowserPermit(parts),
        run: async (raw, signal) =>
          handler(await parts.brandEnrichment, BrandRunIdSchema.parse(raw).runId, signal),
      },
      parts.log,
    );
  return {
    brandFamily: browserStep("brandFamily", (services, runId, signal) =>
      services.family.check(runId, signal),
    ),
    brandResearch: browserStep("brandResearch", (services, runId, signal) =>
      services.research.research(runId, signal),
    ),
  };
}
