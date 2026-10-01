import { expect, it } from "vitest";
import { currentBundle } from "../testing/replay/bundles.js";

it("bundles demand-driven label workflows without activity-side or Node dependencies", async () => {
  const bundle = await currentBundle();
  expect(bundle.code).toContain("label-source-order-v1");
  expect(bundle.code).toContain("label-demand-files-v1");
  expect(bundle.code).toContain("label-image-first/5");
}, 60_000);
