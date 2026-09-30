import { describe, expect, it } from "vitest";
import { ApiConfigSchema } from "./config.js";
import productionShaped from "./fixtures/api-config.json" with { type: "json" };

const target = (workflowType: string) => ({
  clusterId: "tests",
  namespace: "tests",
  taskQueue: "v3.pipeline.product.v1",
  workflowType,
});

describe("API config", () => {
  it("starts brand runs as CollectionWorkflow", () => {
    const config = ApiConfigSchema.parse(productionShaped);
    expect(config.delivery.channels.gnc?.workflowType).toBe("CollectionWorkflow");
  });

  it("refuses the old per-channel brand workflows", () => {
    for (const old of ["BrandCollectionWorkflow", "SwansonCatalogWorkflow"]) {
      const delivery = { ...productionShaped.delivery, channels: { gnc: target(old) } };
      expect(ApiConfigSchema.safeParse({ ...productionShaped, delivery }).success).toBe(false);
    }
  });
});
