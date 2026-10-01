import { expect, it } from "vitest";
import { gateBundle } from "./testing/gate-bundles.js";

it("bundles new and legacy workflow code without Node dependencies", async () => {
  const [current, legacy, prior] = await Promise.all([
    gateBundle(),
    gateBundle(true),
    gateBundle("prior"),
  ]);
  expect(current.code).toContain("resource-gate-v1");
  expect(legacy.code).toContain("resource-recovery-bounds-v1");
  expect(current.code).toContain("resource-execution-stop-proof-v1");
  expect(prior.code).not.toContain("resource-execution-stop-proof-v1");
}, 60_000);
