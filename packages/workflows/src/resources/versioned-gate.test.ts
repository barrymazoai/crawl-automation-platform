import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ patched: false, old: vi.fn(), current: vi.fn() }));
vi.mock("@temporalio/workflow", () => ({ patched: () => state.patched }));
vi.mock("@crawl-automation/v3-product/resource-workflow", () => ({ resourceGate: state.old }));
vi.mock("./resource-gate.js", () => ({ resourceGate: state.current }));

import { versionedResourceGate } from "./versioned-gate.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.patched = false;
  state.old.mockImplementation(() => {
    let sequence = 0;
    return async (_name: string, run: (binding: unknown) => Promise<unknown>) =>
      run({
        activityId: `permit-${sequence++}`,
        cancellationType: "WAIT",
      });
  });
});

it("concurrent first calls in an old history share one permit sequence", async () => {
  const gate = versionedResourceGate(undefined);
  const outcomes = await Promise.all([
    gate("work", async (binding) => binding?.activityId),
    gate("work", async (binding) => binding?.activityId),
  ]);
  expect(outcomes).toEqual(["permit-0", "permit-1"]);
});

it("old capture histories keep ignoring activity bindings", async () => {
  const gate = versionedResourceGate(undefined, { ignoreLegacyBinding: true });
  expect(await gate("capture", async (binding) => binding)).toBeUndefined();
});

it("new histories never initialize the old gate", async () => {
  state.patched = true;
  state.current.mockReturnValue(async () => "new gate");
  expect(await versionedResourceGate(undefined)("work", async () => "work")).toBe("new gate");
  expect(state.old).not.toHaveBeenCalled();
});
