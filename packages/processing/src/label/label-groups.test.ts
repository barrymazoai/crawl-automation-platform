import { describe, expect, it } from "vitest";
import {
  assessLabelCandidate,
  LabelCollectedProductSchema,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { decodeLabelText } from "../text/protocol/label-decoder.js";
import { decodeLabelImage } from "../vision/protocol/label-vision.js";
import { decodeLabelImageV2 } from "../vision/protocol/label-vision-v2.js";
import { collectBoth, mergeSetup, rowsOf } from "../testing/merge-fixture.js";
import { defined } from "../testing/defined.js";
import { labelValidationWarnings } from "./validation-errors.js";

type Row = NonNullable<LabelImageCandidate["formula"]>["columns"][number]["rows"][number];
const field = (text: string) => ({ text, evidence: text });
const warningCode = labelValidationWarnings.code("LABEL.BLEND_WITHOUT_COMPONENTS");

function row(name: string, amount: string | null, options: Partial<Row> = {}): Row {
  return {
    kind: "nutrient",
    name: field(name),
    amount: amount === null ? null : field(amount),
    dailyValue: null,
    amountStatus: amount === null ? "not_declared" : "printed",
    parentRowIndex: null,
    ...options,
  };
}

/** Hand-copied row structures from the Tocomin answers; no saved response or source IDs. */
function tocomin(parentRowIndex: number | null): LabelImageCandidate {
  return {
    codec: "label-extraction/1",
    formula: {
      servingSize: field("1 Softgel"),
      servingsPerContainer: field("150"),
      columns: [{ heading: field("Amount Per Serving"), rows: tocominRows(parentRowIndex) }],
    },
    otherIngredients: { heading: field("Other Ingredients:"), items: [field("Kosher Gelatin")] },
    formulaComplete: true,
    ingredientsComplete: true,
    exclusions: [],
    issues: [],
  };
}

function tocominRows(parentRowIndex: number | null): Row[] {
  const component = { kind: "blend_component" as const, parentRowIndex: 2 };
  return [
    row("Vitamin E (as d-alpha Tocopherol)", "13.4 mg"),
    row("Palm Tocotrienol Complex (as TocoGaia™ Ultra)", "329 mg", { kind: "blend_total" }),
    row("Total d-Mixed Tocotrienols", "50 mg", { kind: "blend_total", parentRowIndex }),
    row("d-gamma Tocotrienol", "23.5 mg", component),
    row("d-alpha Tocotrienol", "17.9 mg", component),
    row("d-delta Tocotrienol", "7 mg", component),
    row("d-beta Tocotrienol", "1.6 mg", component),
    row("Plant Squalene", "4 mg"),
    row("Plant Phytosterol Complex", "4 mg"),
  ];
}

/** Synthetic source text with one field per line, used only to exercise both decoder paths. */
function textAnswer(candidate: LabelImageCandidate) {
  const lines: string[] = [];
  const anchor = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(anchor);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if ("text" in value) {
      const text = String(value.text);
      lines.push(text);
      return { text, fromLine: lines.length, toLine: lines.length };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, anchor(item)]));
  };
  const response = JSON.stringify(anchor(candidate));
  const text = lines.join("\n");
  return { response, text, scope: { range: { start: 0, end: text.length } } };
}

function decoded(candidate: LabelImageCandidate) {
  return [
    decodeLabelText({ ...textAnswer(candidate), policyVersion: "label-text/4" }),
    decodeLabelImage(JSON.stringify(candidate)),
    decodeLabelImageV2(
      JSON.stringify({
        codec: "label-visual-wire/2",
        label: candidate,
        otherIngredientsBlock: field("Kosher Gelatin"),
      }),
    ),
  ];
}

describe("shared label group validation", () => {
  it.each([null, 1])(
    "accepts Tocomin with inner total parent %s without changing rows",
    (parent) => {
      const candidate = tocomin(parent);
      const before = structuredClone(candidate);
      for (const result of decoded(candidate)) {
        expect(result.status).toBe("candidate");
        expect(result.codes).toEqual([]);
        const assessment = assessLabelCandidate(result.candidate);
        expect(assessment.warnings.map((warning) => warning.code)).toEqual(
          parent === null ? [warningCode] : [],
        );
        expect(result.candidate.formula?.columns[0]?.rows[2]?.parentRowIndex).toBe(parent);
        expect(result.candidate.formula?.columns[0]?.rows[1]?.amount?.text).toBe("329 mg");
      }
      expect(candidate).toEqual(before);
    },
  );

  it("allows outer components after a nested blend and its own components", () => {
    const candidate = tocomin(1);
    Object.assign(defined(rowsOf(candidate)[7]), { kind: "blend_component", parentRowIndex: 1 });
    for (const result of decoded(candidate)) {
      expect(result.status).toBe("candidate");
      expect(assessLabelCandidate(result.candidate).warnings).toEqual([]);
    }
  });

  it("keeps a nested childless total's dose and warns only for that inner row", () => {
    const candidate = tocomin(1);
    rowsOf(candidate).splice(3, 4);
    const result = assessLabelCandidate(candidate);
    expect(result.status).toBe("candidate");
    expect(result.warnings).toEqual([
      { code: warningCode, detail: expect.stringContaining("row 2") },
    ]);
  });

  it("accepts the GNC RIPFACTOR childless total and keeps its printed amount", () => {
    const candidate = tocomin(null);
    rowsOf(candidate).splice(
      0,
      9,
      row(
        "RIPFACTOR Mangifera indica (bark) Extract and Sphaeranthus indicus (flower head) Extract",
        "1084 mg",
        { kind: "blend_total" },
      ),
    );
    for (const result of decoded(candidate)) {
      expect(result.status).toBe("candidate");
      expect(assessLabelCandidate(result.candidate).warnings).toHaveLength(1);
      expect(result.candidate.formula?.columns[0]?.rows[0]).toMatchObject({
        kind: "blend_total",
        amount: { text: "1084 mg" },
        parentRowIndex: null,
      });
    }
  });

  it("preserves amount-less GNC group headers with individually dosed components", () => {
    const candidate = tocomin(null);
    rowsOf(candidate).splice(
      0,
      9,
      row("FocusFuel™ Electrolyte Blend", null, {
        kind: "group_header",
        amountStatus: "not_applicable",
      }),
      row("Sodium", "200 mg", { kind: "blend_component", parentRowIndex: 0 }),
      row("Potassium", "100 mg", { kind: "blend_component", parentRowIndex: 0 }),
    );
    for (const result of decoded(candidate)) {
      expect(result.status).toBe("candidate");
      expect(assessLabelCandidate(result.candidate).warnings).toEqual([]);
    }
  });

  it.each([null, 99, 0, 3, 7])("Reviews a component with invalid parent %s", (parent) => {
    const candidate = tocomin(1);
    defined(rowsOf(candidate)[3]).parentRowIndex = parent;
    for (const result of decoded(candidate)) {
      expect(result.status).toBe("review");
      expect(result.codes).toContain("LABEL.PARENT_INVALID");
    }
  });

  it.each([0, 2, 99])("Reviews a nested total with invalid parent %s", (parent) => {
    const candidate = tocomin(parent);
    expect(assessLabelCandidate(candidate).codes).toContain("LABEL.PARENT_INVALID");
  });

  it("Reviews a cycle between blend totals", () => {
    const candidate = tocomin(1);
    defined(rowsOf(candidate)[1]).parentRowIndex = 2;
    for (const result of decoded(candidate)) {
      expect(result.status).toBe("review");
      expect(result.codes).toContain("LABEL.PARENT_INVALID");
    }
  });

  it("Reviews an amount-less childless total and emits no standalone-dose warning", () => {
    const candidate = tocomin(null);
    Object.assign(defined(rowsOf(candidate)[1]), { amount: null, amountStatus: "not_declared" });
    for (const result of decoded(candidate)) {
      expect(result.status).toBe("review");
      expect(result.codes).toEqual(
        expect.arrayContaining(["LABEL.GROUP_EMPTY", "LABEL.AMOUNT_MISSING"]),
      );
      expect(assessLabelCandidate(result.candidate).warnings).toEqual([]);
    }
  });

  it("keeps empty group headers and references to closed groups in Review", () => {
    const candidate = tocomin(null);
    Object.assign(defined(rowsOf(candidate)[1]), {
      kind: "group_header",
      amount: null,
      amountStatus: "not_applicable",
    });
    expect(assessLabelCandidate(candidate).codes).toContain("LABEL.GROUP_EMPTY");
    defined(rowsOf(candidate)[3]).parentRowIndex = 1;
    expect(assessLabelCandidate(candidate).codes).toContain("LABEL.PARENT_INVALID");
  });

  it.each([null, 1])(
    "persists honest grouping and warnings through collection (parent %s)",
    async (parent) => {
      const candidate = tocomin(parent);
      const setup = await mergeSetup([candidate], candidate);
      const record = await collectBoth(setup);
      expect(LabelCollectedProductSchema.safeParse(record).success).toBe(true);
      expect(record.formula.columns[0]?.rows[2]?.parentRowIndex).toBe(parent);
      expect(record.formula.columns[0]?.rows[1]?.amount?.text).toBe("329 mg");
      expect(record.warnings).toEqual(
        parent === null
          ? [
              { id: "a-text", code: warningCode },
              { id: "source-0", code: warningCode },
            ]
          : [],
      );
      expect(record.provenance).toHaveLength(2);
    },
  );

  it("records one warning per source even with multiple standalone blend totals", async () => {
    const candidate = tocomin(null);
    defined(rowsOf(candidate)[7]).kind = "blend_total";
    const setup = await mergeSetup([candidate], candidate);
    const record = await collectBoth(setup);
    expect(record.warnings).toEqual([
      { id: "a-text", code: warningCode },
      { id: "source-0", code: warningCode },
    ]);
  });
});
