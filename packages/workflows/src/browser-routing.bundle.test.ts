import { expect, it } from "vitest";
import { currentBundle, withoutPatches } from "./testing/replay/bundles.js";

it("bundles the routing patch and executable legacy branch without Node dependencies", async () => {
  const current = await currentBundle();
  expect(withoutPatches(current, ["browser-resource-routing-v1"]).code).not.toBe(current.code);
}, 60_000);
