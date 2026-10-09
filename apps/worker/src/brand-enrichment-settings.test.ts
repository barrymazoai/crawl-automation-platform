import { expect, it } from "vitest";
import { z } from "zod";
import {
  BrandEnrichmentSettingsSchema,
  validateBrandEnrichmentSettings,
} from "./brand-enrichment-settings.js";
const schema = z
  .object({
    brandEnrichment: BrandEnrichmentSettingsSchema,
    resourceKinds: z.record(z.string(), z.enum(["browser", "model"])),
  })
  .superRefine(validateBrandEnrichmentSettings);
function settings() {
  const model = [{ resourceId: "model-account", units: 1 }];
  return {
    secretsFile: "/tmp/private.env",
    reviewerModel: "test-model",
    taskQueue: "brands",
    queues: { activities: "brands", model: "model", browser: "browser" },
    resources: {
      queue: "resources",
      activities: {
        brandFamily: [{ resourceId: "mini-ego-space-1", units: 1 }, ...model],
        brandResearch: [{ resourceId: "mini-ego-space-1", units: 1 }, ...model],
        brandApollo: model,
        brandContacts: model,
        brandReview: model,
      },
    },
  };
}
it("requires model and browser permits for the corresponding brand activities", () => {
  const input = {
    brandEnrichment: settings(),
    resourceKinds: { "model-account": "model", "mini-ego-space-1": "browser" },
  };
  expect(schema.safeParse(input).success).toBe(true);
  input.brandEnrichment.resources.activities.brandResearch = [
    { resourceId: "mini-ego-space-1", units: 1 },
  ];
  expect(schema.safeParse(input).success).toBe(false);
});
it("rejects a relative secret-file path", () => {
  expect(
    BrandEnrichmentSettingsSchema.safeParse({ ...settings(), secretsFile: "private.env" }).success,
  ).toBe(false);
});
