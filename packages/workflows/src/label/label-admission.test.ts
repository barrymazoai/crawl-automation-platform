import { expect, it, vi } from "vitest";
const prepared = vi.hoisted(() => vi.fn());
vi.mock("./label-page.js", () => ({ pageEvidence: prepared }));
vi.mock("@temporalio/workflow", async () => ({
  ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure,
  isCancellation: () => false,
  log: { warn: vi.fn() },
}));
import { admissionDocuments } from "./label-admission.js";
import { LabelWorkflowInputSchema, LoadedPlanSchema } from "./label-model.js";
import { entry, manifest } from "./label-fixture.js";
import type { LabelRun } from "./label-run.js";
import type { OrderedWalk } from "./label-ordered.js";

function fixture() {
  const input = LabelWorkflowInputSchema.parse({
    ...entry,
    input: { ...entry.input, admission: "label-packaging/1", corePolicy: "test-core/1" },
  });
  const run: LabelRun = {
    entry: input,
    call: vi.fn(),
    waiting: [],
    quarantined: [],
    heartbeatFailures: [],
    stream: { ready: vi.fn(), finish: vi.fn() },
  };
  const loaded = LoadedPlanSchema.parse({ input: input.input, manifest });
  const walk: OrderedWalk = {
    ordered: true,
    complete: true,
    selectedImageId: null,
    states: [],
    notStarted: [],
  };
  return { run, loaded, walk };
}

it("prepares full page packaging evidence after images win, without the text model or label core", async () => {
  const test = fixture();
  prepared.mockReset().mockResolvedValue({ document: {}, range: {} });
  await admissionDocuments(test.run, test);
  expect(prepared).toHaveBeenCalledOnce();
  expect(prepared.mock.calls[0]?.[0].entry.input.corePolicy).toBeUndefined();
  expect(test.run.call).not.toHaveBeenCalled();
  expect(test.walk.complete).toBe(true);
  expect(test.walk.states).toEqual([]);
});

it("keeps a failed packaging page in Review even after a complete image", async () => {
  const test = fixture();
  prepared.mockReset().mockResolvedValue({ id: "page", status: "review", reviewId: "page-review" });
  await admissionDocuments(test.run, test);
  expect(test.walk.complete).toBe(false);
  expect(test.walk.states).toEqual([{ id: "page", status: "review", reviewId: "page-review" }]);
});

it("does not prepare page evidence twice after text has already run", async () => {
  const test = fixture();
  test.walk.states.push({ id: "page", status: "registered" });
  prepared.mockReset();
  await admissionDocuments(test.run, test);
  expect(prepared).not.toHaveBeenCalled();
});
