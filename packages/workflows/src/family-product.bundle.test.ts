import { expect, it } from "vitest";
import { currentBundle, withoutPatches } from "./testing/replay/bundles.js";
it("bundles current and executable historical family/follower branches", async () => {
  const bundle = await currentBundle();
  expect(
    withoutPatches(bundle, ["family-formula-outcomes-v1", "capture-follower-v1"]).code,
  ).not.toEqual(bundle.code);
}, 60_000);
