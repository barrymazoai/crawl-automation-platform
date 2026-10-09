import { expect, it } from "vitest";
import { currentBundle } from "./testing/replay/bundles.js";

it("bundles and registers the products-only retry without application dependencies", async () => {
  const bundle = await currentBundle();
  expect(bundle.code).toContain("BrandProductsRetryWorkflow");
  expect(bundle.code).toContain("runBrandProducts");
}, 60_000);
