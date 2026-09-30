import { expect, it } from "vitest";
import { gateBundle } from "./testing/gate-bundles.js";

it("bundles new and legacy workflow code without Node dependencies", async () => {
  const [current, legacy] = await Promise.all([gateBundle(), gateBundle(true)]);
  expect(current.code).toContain("resource-gate-v1");
  expect(legacy.code).toContain("resource-recovery-bounds-v1");
}, 60_000);
