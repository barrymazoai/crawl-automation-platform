import { describe, expect, it, vi } from "vitest";
import { withMeasurementContext, type Measurement } from "@crawl-automation/platform";
import {
  LabelImageCandidateSchema,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { labelAnswer, labelConfig, signal, visionSetup } from "../testing/vision-fixture.js";
import { CodexVisionModel } from "./codex-vision-model.js";
import {
  LabelVisionRepairAnswerSchema,
  decodeLabelVisionRepair,
  labelVisionRepairFingerprint,
} from "./protocol/label-vision-repair.js";
import { VisionResponseSchema, visionKeys } from "./vision-files.js";
import { VisionStep } from "./vision-step.js";

function brokenParent() {
  const candidate = LabelImageCandidateSchema.parse(JSON.parse(labelAnswer()));
  row14(candidate).parentRowIndex = 14;
  return candidate;
}

function row14(candidate: LabelImageCandidate) {
  const row = candidate.formula?.columns[0]?.rows[14];
  if (!row) {
    throw new Error("fixture row 14 missing");
  }
  return row;
}

function runRepair(
  original: LabelImageCandidate,
  makeRepair: (original: LabelImageCandidate) => LabelImageCandidate,
) {
  const fixture = visionSetup({ answer: JSON.stringify(original) });
  const repair = vi.fn(async (input: { original: LabelImageCandidate }) =>
    JSON.stringify(makeRepair(input.original)),
  );
  const model = {
    ...fixture.model,
    repairEnabled: true,
    repairFingerprint: "a".repeat(64),
    repair,
  };
  return { ...fixture, repair, step: new VisionStep({ ...fixture.deps, model }) };
}

function retained(fixture: ReturnType<typeof runRepair>) {
  const bytes = fixture.remote.data.get(visionKeys.response(fixture.task));
  if (!bytes) {
    throw new Error("retained response missing");
  }
  const response = VisionResponseSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  return LabelVisionRepairAnswerSchema.parse(JSON.parse(response.raw));
}

describe("one structural label repair", () => {
  it("keeps the old visual setup fingerprint when repair settings change", () => {
    const baseline = CodexVisionModel.describe(labelConfig).configFingerprint;
    const disabled = { ...labelConfig, repair: { enabled: false } };
    const alternate = {
      ...labelConfig,
      repair: {
        enabled: true,
        settings: { provider: "fixture", model: "fixture-repair", reasoningEffort: "high" },
      },
    };
    expect(CodexVisionModel.describe(disabled).configFingerprint).toBe(baseline);
    expect(CodexVisionModel.describe(alternate).configFingerprint).toBe(baseline);
    expect(labelVisionRepairFingerprint(alternate)).not.toBe(
      labelVisionRepairFingerprint(labelConfig),
    );
  });

  it("repairs an invalid parent and registers the retained original, findings and repair", async () => {
    const original = brokenParent();
    const fixture = runRepair(original, (prior) => {
      row14(prior).parentRowIndex = 13;
      return prior;
    });
    const outcome = await fixture.step.run(fixture.task, signal());
    expect(outcome).toMatchObject({ status: "registered", candidateStatus: "candidate" });
    expect(fixture.repair).toHaveBeenCalledOnce();
    expect(fixture.model.calls).toBe(1);
    expect(fixture.registry.writes).toBe(1);
    const saved = retained(fixture);
    expect(saved.operationId).toBe(`${fixture.task.input.operationId}:repair`);
    expect(saved.originalRaw).toBe(JSON.stringify(original));
    expect(saved.findings).toEqual([
      expect.objectContaining({
        code: "LABEL.PARENT_INVALID",
        rowIndex: 14,
      }),
    ]);
    if (!saved.repairRaw) {
      throw new Error("repair answer missing");
    }
    expect(JSON.parse(saved.repairRaw).formula.columns[0].rows[14].parentRowIndex).toBe(13);
    expect(fixture.remote.data.has(visionKeys.repairOriginal(fixture.task))).toBe(true);
    expect(await fixture.results.inspect(fixture.task, signal())).toMatchObject({
      artifactDurable: true,
      resultRegistered: true,
    });
  });

  it("rejects a repair that changes an amount and keeps the original Review code", async () => {
    const original = brokenParent();
    const fixture = runRepair(original, (prior) => {
      row14(prior).parentRowIndex = 13;
      const amount = row14(prior).amount;
      if (!amount) {
        throw new Error("fixture amount missing");
      }
      amount.text = "999 mg";
      return prior;
    });
    const outcome = await fixture.step.run(fixture.task, signal());
    expect(outcome).toMatchObject({ status: "review", code: "VISION.LABEL_PARENT_INVALID" });
    expect(retained(fixture).repairCodes).toEqual(["VISION.REPAIR_CHANGED_CONTENT"]);
    const review = fixture.reviews.records.get(outcome.status === "review" ? outcome.reviewId : "");
    expect(review?.rawError.details).toMatchObject({
      repairCodes: ["VISION.REPAIR_CHANGED_CONTENT"],
    });
    expect(fixture.registry.writes).toBe(0);
  });

  it("does not repair an unreadable amount", async () => {
    const original = LabelImageCandidateSchema.parse(JSON.parse(labelAnswer()));
    row14(original).amount = null;
    row14(original).amountStatus = "unreadable";
    const fixture = runRepair(original, (prior) => prior);
    expect(await fixture.step.run(fixture.task, signal())).toMatchObject({
      status: "review",
      code: "VISION.LABEL_AMOUNT_UNREADABLE",
    });
    expect(fixture.repair).not.toHaveBeenCalled();
  });

  it("makes at most one repair call when the structural finding remains", async () => {
    const original = brokenParent();
    const fixture = runRepair(original, (prior) => prior);
    expect(await fixture.step.run(fixture.task, signal())).toMatchObject({
      status: "review",
      code: "VISION.LABEL_PARENT_INVALID",
    });
    expect(fixture.repair).toHaveBeenCalledOnce();
    expect(retained(fixture).repairCodes).toContain("LABEL.PARENT_INVALID");
  });

  it("records the repair as its own model-image usage event", async () => {
    const fixture = runRepair(brokenParent(), (prior) => {
      row14(prior).parentRowIndex = 13;
      return prior;
    });
    const events: Measurement[] = [];
    const identity = {
      channel: null,
      runId: null,
      operationId: fixture.task.input.operationId,
      sourceId: null,
      sourceHash: null,
      workflowId: null,
      temporalRunId: null,
      scanId: null,
    };
    await withMeasurementContext(
      {
        identity,
        events,
        log: { info: vi.fn(), error: vi.fn() } as unknown as Parameters<
          typeof withMeasurementContext
        >[0]["log"],
        record: async () => undefined,
      },
      () => fixture.step.run(fixture.task, signal()),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "model-image",
        step: "label-vision-repair",
        providerCall: true,
        operationId: `${fixture.task.input.operationId}:repair`,
      }),
    );
  });

  it("accepts only a content-preserving Other Ingredients boundary merge", () => {
    const original = LabelImageCandidateSchema.parse(JSON.parse(labelAnswer()));
    if (!original.otherIngredients) {
      throw new Error("fixture ingredients missing");
    }
    original.otherIngredients.items = [
      { text: "BSE-free gelatin", evidence: "BSE-free gelatin" },
      { text: "(capsule)", evidence: "(capsule)" },
    ];
    const repaired = structuredClone(original);
    if (!repaired.otherIngredients) {
      throw new Error("fixture ingredients missing");
    }
    repaired.otherIngredients.items = [
      { text: "BSE-free gelatin (capsule)", evidence: "BSE-free gelatin (capsule)" },
    ];
    expect(decodeLabelVisionRepair(JSON.stringify(repaired), original, true).codes).toEqual([]);
    const first = repaired.otherIngredients.items[0];
    if (!first) {
      throw new Error("repaired item missing");
    }
    first.text = "BSE-free gelatin (tablet)";
    expect(decodeLabelVisionRepair(JSON.stringify(repaired), original, true).codes).toEqual([
      "VISION.REPAIR_CHANGED_CONTENT",
    ]);
  });
});
