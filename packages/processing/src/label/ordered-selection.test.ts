import { expect, it, vi } from "vitest";
import { labelCandidate } from "../testing/label-sources.js";
import { orderedFixture } from "./ordered-fixture.js";
import { orderedSources } from "./ordered-selection.js";
import { defined } from "../testing/defined.js";

const signal = () => AbortSignal.timeout(5_000);
const registered = (id: string) => ({ id, status: "registered" as const });
const notStarted = (id: string) => ({ id, status: "not_started" as const });

it("selects a complete first image without resolving or retaining unused images or text", async () => {
  const fixture = await orderedFixture();
  const request = { input: fixture.input, states: [registered("source-0")] };
  expect(await fixture.selection.inspect(request, signal())).toMatchObject({ complete: true });
  await fixture.selection.manifest(
    {
      ...request,
      selectedImageId: null,
      states: [...request.states, notStarted("source-1"), notStarted("a-text")],
    },
    signal(),
  );
  expect(fixture.plans.source.mock.calls.every(([call]) => call.sourceId === "source-0")).toBe(
    true,
  );
  expect(fixture.inspection.file).toHaveBeenCalledTimes(2);
  expect(fixture.plans.publishManifest).toHaveBeenCalledWith(
    expect.objectContaining({
      skipped: ["source-1", "a-text"],
      sources: [fixture.tasks.get("source-0")],
    }),
    expect.any(AbortSignal),
  );
});

it("accepts complete page text and retains every unused image as an inactive descriptor", async () => {
  const fixture = await orderedFixture({ order: "text-first" });
  const request = { input: fixture.input, states: [registered("a-text")] };
  expect(await fixture.selection.inspect(request, signal())).toMatchObject({ complete: true });
  expect(fixture.inspection.file).not.toHaveBeenCalled();
  expect(fixture.plans.source).toHaveBeenCalledOnce();
});

it("keeps going for one complete facts panel and stops only after its ingredients panel", async () => {
  const formula = labelCandidate();
  const column = defined(defined(formula.formula).columns[0]);
  column.rows = column.rows.slice(0, 4);
  formula.otherIngredients = null;
  formula.ingredientsComplete = false;
  const ingredients = labelCandidate();
  ingredients.formula = null;
  ingredients.formulaComplete = false;
  const fixture = await orderedFixture({ candidates: [formula, ingredients] });
  const request = { input: fixture.input, states: [registered("source-0")] };
  expect(await fixture.selection.inspect(request, signal())).toMatchObject({ complete: false });
  request.states.push(registered("source-1"));
  expect(await fixture.selection.inspect(request, signal())).toMatchObject({ complete: true });
});

it("does not accept partial text even if planning had called the facts complete", async () => {
  const text = labelCandidate();
  text.formulaComplete = false;
  const fixture = await orderedFixture({ order: "text-first", text });
  expect(
    await fixture.selection.inspect(
      { input: fixture.input, states: [registered("a-text")] },
      signal(),
    ),
  ).toMatchObject({ complete: false, terminal: false, reason: { sourceId: "a-text" } });
});

it("never permits text without a deterministic label section, or attempts out of rank order", async () => {
  const fixture = await orderedFixture({ order: "text-first", pageHasLabelSection: false });
  expect(orderedSources(fixture.loaded)).toEqual(["source-0", "source-1"]);
  for (const id of ["a-text", "source-1"]) {
    await expect(
      fixture.selection.inspect({ input: fixture.input, states: [registered(id)] }, signal()),
    ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
  }
});

it("blocks unknown execution even beside a complete candidate", async () => {
  const fixture = await orderedFixture();
  expect(
    await fixture.selection.inspect(
      {
        input: fixture.input,
        states: [{ id: "source-0", status: "unresolved" }, registered("source-1")],
      },
      signal(),
    ),
  ).toMatchObject({ complete: false, terminal: true });
});

it("rejects a registered answer from another task", async () => {
  const fixture = await orderedFixture();
  const source = defined(fixture.tasks.get("source-1"));
  const wrong = defined(fixture.entries.get(source.id));
  vi.mocked(defined(fixture.inspection.readSource)).mockResolvedValue({ ...wrong, id: "source-0" });
  await expect(
    fixture.selection.inspect({ input: fixture.input, states: [registered("source-0")] }, signal()),
  ).rejects.toMatchObject({ code: "LABEL_PRODUCT.IDENTITY_CONFLICT" });
});

it("does not let two conflicting image answers claim completeness", async () => {
  const conflict = labelCandidate();
  defined(conflict.formula).servingSize = { text: "999", evidence: "999" };
  const fixture = await orderedFixture({ candidates: [conflict, labelCandidate()] });
  expect(
    await fixture.selection.inspect(
      { input: fixture.input, states: [registered("source-0"), registered("source-1")] },
      signal(),
    ),
  ).toMatchObject({ complete: false });
});

it("refuses a claimed early stop with incomplete evidence", async () => {
  const partial = labelCandidate();
  partial.formulaComplete = false;
  const fixture = await orderedFixture({ candidates: [partial, labelCandidate()] });
  await expect(
    fixture.selection.manifest(
      {
        input: fixture.input,
        selectedImageId: null,
        states: [registered("source-0"), notStarted("source-1"), notStarted("a-text")],
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
});

it("keeps Drug Facts complete without supplement serving-size metadata", async () => {
  const drug = labelCandidate();
  const field = (text: string) => ({ text, evidence: text });
  drug.formula = {
    drugFacts: field("Drug Facts"),
    servingSize: null,
    servingsPerContainer: null,
    columns: [
      {
        heading: field("Active ingredient (in each tablet)"),
        rows: [
          {
            kind: "nutrient",
            name: field("Arnica montana"),
            amount: field("30C HPUS"),
            purpose: field("Relieves muscle pain"),
            dailyValue: null,
            amountStatus: "printed",
            parentRowIndex: null,
          },
        ],
      },
    ],
  };
  drug.otherIngredients = {
    heading: field("Inactive Ingredients:"),
    items: [field("lactose"), field("sucrose")],
  };
  const fixture = await orderedFixture({ candidates: [drug] });
  expect(
    await fixture.selection.inspect(
      { input: fixture.input, states: [registered("source-0")] },
      signal(),
    ),
  ).toMatchObject({ complete: true });
});

it.each([
  ["FILE.TIMEOUT", false],
  ["PAGE.IDENTITY_CONFLICT", true],
  ["PAGE.HANDOFF_UNVERIFIED", true],
] as const)(
  "retains the furthest formula reason and the safety stop for %s",
  async (code, terminal) => {
    const partial = labelCandidate();
    partial.formulaComplete = false;
    const fixture = await orderedFixture({ candidates: [partial, labelCandidate()] });
    const review = {
      schemaVersion: 1,
      reviewId: "file-review",
      occurredAt: "2026-10-01T00:00:00.000Z",
      observation: fixture.input.owner,
      failure: {
        schemaVersion: 1,
        requestId: fixture.input.owner.requestId,
        observationId: fixture.input.owner.observationId,
        operationId: "file-op-1",
        inputFingerprint: "a".repeat(64),
        stage: "file.acquire",
        category: "PROCESSING",
        code,
        executionFact: "executed",
        evidenceKey: "file/review.json",
        blockedBy: null,
        automaticRetry: false,
      },
      rawError: { name: "FileFailure", message: "file failed", stack: null, details: {} },
      candidate: null,
      inspection: { kind: "none" },
    };
    vi.mocked(fixture.inspection.review).mockResolvedValue(review);
    fixture.inspection.reviewSource = vi.fn(async () => ({
      status: "review" as const,
      code,
    }));
    const check = await fixture.selection.inspect(
      {
        input: fixture.input,
        states: [
          registered("source-0"),
          { id: "source-1", status: "review", reviewId: "file-review" },
        ],
      },
      signal(),
    );
    expect(check).toMatchObject({
      complete: false,
      terminal,
      reason: { sourceId: "source-0" },
    });
  },
);
