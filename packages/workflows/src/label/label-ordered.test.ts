import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ process: vi.fn(), log: vi.fn() }));
vi.mock("@temporalio/workflow", async () => ({
  ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure,
  isCancellation: () => false,
  patched: () => true,
  log: { info: mocks.log, warn: vi.fn() },
}));
vi.mock("./label-source.js", () => ({ processSource: mocks.process }));
import { orderedLabel } from "./label-ordered.js";
import { LabelWorkflowInputSchema, type Source } from "./label-model.js";
import { entry, manifest } from "./label-fixture.js";
import type { SourceWork } from "./label-source.js";

function fixture(order: "text-first" | "images-first", options = { hasLabel: true }) {
  const input = LabelWorkflowInputSchema.parse({
    ...entry,
    input: {
      ...entry.input,
      evidencePolicy: "label-image-first/6",
      sourcePolicy: { version: "label-sources/1", order },
    },
  });
  const sources = [
    manifest.sources[0],
    { id: "front", kind: "file-image" },
    { id: "facts", kind: "file-image" },
    { id: "ingredients", kind: "file-image" },
  ] as Source[];
  const loaded = {
    input: input.input,
    manifest: { ...manifest, sources },
    imageOrder: ["facts", "ingredients", "front"],
    labelPreparation: { pageHasLabelSection: options.hasLabel, pageFactsComplete: true },
  };
  const check = vi.fn(async (_kind: string, _name: string, request: unknown) => ({
    input: request,
    complete: false,
    terminal: false,
  }));
  const work: SourceWork = {
    issued: new Map(),
    ocrPending: new Map(),
    run: {
      entry: input,
      call: check,
      waiting: [],
      quarantined: [],
      heartbeatFailures: [],
      stream: { ready: vi.fn(async () => true), finish: vi.fn(async () => true) },
    },
  };
  return { loaded, work, check };
}

beforeEach(() => {
  mocks.process
    .mockReset()
    .mockImplementation(async (_work, source: Source) => ({ id: source.id, status: "registered" }));
  mocks.log.mockClear();
});

it("runs the highest-ranked image first and stops downloads, OCR and model calls at completeness", async () => {
  const test = fixture("images-first");
  test.check.mockImplementation(async (_kind, _name, request) => ({
    input: request,
    complete: true,
    terminal: false,
  }));
  const result = await orderedLabel(test.work, test.loaded);
  expect(result.complete).toBe(true);
  expect(mocks.process.mock.calls.map(([, source]) => source.id)).toEqual(["facts"]);
  expect(test.work.ocrPending.size).toBe(0);
  expect(result.notStarted.map((state) => state.id)).toEqual(["page", "front", "ingredients"]);
});

it("waits for both panels before stopping and never runs text once the label is complete", async () => {
  const test = fixture("images-first");
  test.check.mockImplementation(async (_kind, _name, request) => ({
    input: request,
    complete: (request as { states: unknown[] }).states.length === 2,
    terminal: false,
  }));
  await orderedLabel(test.work, test.loaded);
  expect(mocks.process.mock.calls.map(([, source]) => source.id)).toEqual(["facts", "ingredients"]);
});

it("runs only text when the verified text answer is complete", async () => {
  const test = fixture("text-first");
  test.check.mockImplementation(async (_kind, _name, request) => ({
    input: request,
    complete: true,
    terminal: false,
  }));
  await orderedLabel(test.work, test.loaded);
  expect(mocks.process.mock.calls.map(([, source]) => source.id)).toEqual(["page"]);
});

it.each(["text-first", "images-first"] as const)(
  "activates fallback after incomplete %s sources",
  async (order) => {
    const test = fixture(order);
    await orderedLabel(test.work, test.loaded);
    expect(mocks.process.mock.calls.map(([, source]) => source.id)).toEqual(
      order === "text-first"
        ? ["page", "facts", "ingredients", "front"]
        : ["facts", "ingredients", "front", "page"],
    );
  },
);

it.each(["text-first", "images-first"] as const)(
  "skips marketing text completely with %s",
  async (order) => {
    const test = fixture(order, { hasLabel: false });
    await orderedLabel(test.work, test.loaded);
    expect(mocks.process.mock.calls.map(([, source]) => source.id)).toEqual([
      "facts",
      "ingredients",
      "front",
    ]);
    expect(mocks.log).toHaveBeenCalledWith("Label source skipped", {
      sourceId: "page",
      reason: "no_label_section",
    });
  },
);

it("stops on unknown execution rather than activating another source", async () => {
  const test = fixture("images-first");
  test.check.mockImplementation(async (_kind, _name, request) => ({
    input: request,
    complete: false,
    terminal: true,
  }));
  const result = await orderedLabel(test.work, test.loaded);
  expect(result.complete).toBe(false);
  expect(mocks.process).toHaveBeenCalledOnce();
});

it("keeps the reason chosen from the furthest source", async () => {
  const test = fixture("images-first");
  const reason = {
    sourceId: "facts",
    code: "VISION.LABEL_FORMULA_INCOMPLETE",
    executionFact: "executed",
  };
  test.check.mockImplementation(async (_kind, _name, request) => ({
    input: request,
    complete: false,
    terminal: false,
    reason,
  }));
  expect((await orderedLabel(test.work, test.loaded)).reason).toEqual(reason);
});
