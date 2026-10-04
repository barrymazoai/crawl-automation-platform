import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import fixture from "../fixtures/gnc-label-candidate.json" with { type: "json" };
import { legacyCandidate } from "../../testing/vision-fixture.js";
import {
  decodeLabelImage,
  labelVisionOutputSchema,
  labelVisionPolicyVersion,
  labelVisionPrompt,
} from "./label-vision.js";
import {
  decodeLabelImageV2,
  labelVisionOutputV2Schema,
  labelVisionPromptV2,
} from "./label-vision-v2.js";
import { visionOutputSchema, visionPrompt } from "./legacy-vision.js";

const labelCandidate = (): LabelImageCandidate => structuredClone(fixture) as LabelImageCandidate;
const field = (text: string) => ({ text, evidence: text });
const wire = (label: LabelImageCandidate, block: unknown) =>
  JSON.stringify({ codec: "label-visual-wire/2", label, otherIngredientsBlock: block });
const ingredientsText = (label: LabelImageCandidate) =>
  (label.otherIngredients?.items ?? []).map((item) => item.text).join(", ");
const sha = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

function withDailyValueHeader(): LabelImageCandidate {
  const label = labelCandidate();
  const columns = label.formula?.columns ?? [];
  const row = columns[0]?.rows[1];
  if (row) {
    row.dailyValue = field("1%");
  }
  const heading = field("% Daily Value");
  const header = {
    kind: "group_header" as const,
    name: heading,
    amount: null,
    dailyValue: null,
    amountStatus: "not_applicable" as const,
    parentRowIndex: null,
  };
  columns.push({ heading, rows: [header] });
  return label;
}

// Cases carried over from the former vision label-extraction module.
describe("vision answer formats", () => {
  it("keep every prompt and answer schema byte-identical (they are part of each setup's fingerprint)", () => {
    expect(sha(visionPrompt)).toBe(
      "df676b3ec97fed9040c236a7dcf818cdca52430b7fe07990da49800511e6cbc5",
    );
    expect(sha(visionOutputSchema)).toBe(
      "52a08fad889754ac35b358362abf1145817e6c35831d75f09207037870d0bf71",
    );
    expect(sha(labelVisionPrompt)).toBe(
      "8540e2154833f124dbee09bb9acf27513ea0f46a087610b0140cb65974d0cfae",
    );
    expect(sha(labelVisionOutputSchema)).toBe(
      "9066378b09630a7fc220ed8c5e5607e70788c4150df668fca3d2a95c616ac647",
    );
    expect(sha(labelVisionPromptV2)).toBe(
      "363d90d348f03fd1690ffe1fb1ff6af89a5f221f8841f4be343184b26f0b19c3",
    );
    expect(sha(labelVisionOutputV2Schema)).toBe(
      "22dbd982e96d1dfa7c28485cf729734a0e2ca4c79ae966365c8e721ca63512c0",
    );
    expect(labelVisionPolicyVersion).toBe("label-vision/8");
  });

  it("accept explicit typed headings without a false core-missing Review", () => {
    expect(decodeLabelImage(JSON.stringify(labelCandidate()))).toMatchObject({
      status: "candidate",
      codes: [],
    });
  });

  it("still fail a missing readable dose, keeping the printed metadata", () => {
    const label = labelCandidate();
    const row = label.formula?.columns[0]?.rows[14];
    if (row) {
      row.amount = null;
    }
    const result = decodeLabelImage(JSON.stringify(label));
    expect(result.status).toBe("review");
    expect(result.candidate.formula?.servingsPerContainer?.text).toBe("3");
  });

  it("never relabel an old-format answer; the label schema stays strict", () => {
    expect(() => decodeLabelImage(JSON.stringify(legacyCandidate))).toThrow();
    expect(JSON.stringify(labelVisionOutputSchema)).toContain('"additionalProperties":false');
  });

  it("fold an exact data-free % Daily Value column into an excluded heading, changing no dose", () => {
    const label = withDailyValueHeader();
    const raw = JSON.stringify(label);
    const decoded = decodeLabelImage(raw);
    expect(decoded.status).toBe("candidate");
    expect(decoded.candidate.formula?.columns).toEqual([label.formula?.columns[0]]);
    expect(decoded.candidate.exclusions).toContainEqual({
      reason: "heading",
      quote: field("% Daily Value"),
    });
    expect(JSON.stringify(label)).toBe(raw);
  });

  it.each([
    "amount",
    "dailyValue",
    "extraRow",
    "citation",
    "parent",
    "otherHeading",
    "missingPercent",
    "multipleDoseBases",
  ])("never fold an uncertain or data-bearing % Daily Value column: %s", (kind) => {
    const label = withDailyValueHeader();
    const columns = label.formula?.columns ?? [];
    const [dose, header] = columns;
    const row = header?.rows[0];
    if (!dose || !header || !row) {
      throw new Error("fixture has no header column");
    }
    const changes: Record<string, () => void> = {
      amount: () => Object.assign(row, { amount: field("1 mg"), amountStatus: "printed" }),
      dailyValue: () => Object.assign(row, { dailyValue: field("2%") }),
      extraRow: () => header.rows.push(structuredClone(dose.rows[0] ?? row)),
      citation: () => Object.assign(row.name, { evidence: "% Daily Value 44%" }),
      parent: () => Object.assign(row, { parentRowIndex: 0 }),
      otherHeading: () => Object.assign(header, { heading: field("Per 2 capsules") }),
      missingPercent: () => dose.rows.forEach((each) => Object.assign(each, { dailyValue: null })),
      multipleDoseBases: () => columns.push(structuredClone(dose)),
    };
    changes[kind]?.();
    expect(decodeLabelImage(JSON.stringify(label)).candidate.formula?.columns).toEqual(columns);
  });

  it("v2 folds the same heading and still takes the ingredient list from the transcription", () => {
    const label = withDailyValueHeader();
    const text = ingredientsText(label);
    const result = decodeLabelImageV2(wire(label, field(text)));
    expect(result.status).toBe("candidate");
    expect(result.candidate.formula?.columns).toHaveLength(1);
    expect(result.candidate.otherIngredients).toEqual(label.otherIngredients);
  });

  it("v2 splits the transcribed body, not the model's own item list", () => {
    const label = labelCandidate();
    if (label.otherIngredients) {
      label.otherIngredients.items = [field("(capsule)")];
    }
    const text =
      "BSE-free gelatin (capsule), vegetable glycerine, double-distilled and deionized water";
    const decoded = decodeLabelImageV2(wire(label, field(text)));
    expect(decoded.status).toBe("candidate");
    expect(decoded.candidate.otherIngredients?.items.map((item) => item.text)).toEqual(
      text.split(", "),
    );
  });

  it("v2 refuses a missing or contradictory transcription instead of inventing ingredients", () => {
    for (const block of [null, { text: "water", evidence: "oil" }]) {
      expect(decodeLabelImageV2(wire(labelCandidate(), block)).codes).toContain(
        "LABEL.INGREDIENT_BOUNDARY",
      );
    }
  });
});
