import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodeVisionResult } from "../vision/protocol/vision-protocol.js";
import { keywordPolicyFor, type LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { agreementCandidate, agreementField } from "./label-agreement-fixture.js";
import { mergeLabelProduct } from "./label-merge.js";

/** KAN-243 B09DKW81VV (amazon.in, 2026-11-07): the same tablet read on two images, the ingredient named two ways. */
const INDIA = ["us-facts/1", "in-nutritional-information/2", "in-composition/2"] as const;

function tablet(serving: string, name: string, heading: string | null): LabelImageCandidate {
  const candidate = agreementCandidate();
  const formula = defined(candidate.formula);
  defined(formula.columns[0]).heading = heading ? agreementField(heading) : null;
  formula.servingSize = agreementField(serving);
  formula.servingsPerContainer = null;
  defined(formula.columns[0]).rows = [
    {
      kind: "nutrient",
      name: agreementField(name),
      amount: agreementField("1500 mcg"),
      amountStatus: "printed",
      dailyValue: null,
      parentRowIndex: null,
    },
  ];
  // As both images were read: the tablet's panel, its Other Ingredients section not in view.
  return {
    ...candidate,
    otherIngredients: null,
    ingredientsComplete: false,
    issues: [{ code: "INGREDIENTS_MISSING", detail: "Other Ingredients section is not visible." }],
  };
}

function merge(formats?: readonly string[]) {
  const setup = assemblySetup([
    tablet("1 tablet", "Vitamin B12 (Methylcobalamin IP)", "Each serving contains"),
    tablet("film coated tablet", "Methylcobalamin IP", null),
  ]);
  setup.join.manifest.evidencePolicy = "label-image-first/7";
  if (formats) {
    // The images were selected in the India formats: their tasks and records say so.
    const policy = keywordPolicyFor(formats as typeof INDIA);
    for (const source of setup.join.manifest.sources) {
      if (source.kind === "image") {
        source.task.input.selection.policy = policy;
      }
    }
    for (const entry of setup.entries.values()) {
      if (entry.kind === "image") {
        entry.record.input.selection.policy = policy;
      }
    }
  }
  return mergeLabelProduct(setup.join.manifest, { entries: [...setup.entries.values()] });
}

it("India: one ingredient named two ways with the same amount is one reading, with a wording warning", () => {
  const merged = merge(INDIA);
  expect(merged.codes).not.toContain("LABEL_PRODUCT.FORMULA_CONFLICT");
  expect(merged.warnings.map((warning) => warning.code)).toContain(
    "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS",
  );
});

it("US: the same two readings still conflict", () => {
  expect(merge().codes).toContain("LABEL_PRODUCT.FORMULA_CONFLICT");
});
it.skipIf(!process.env["B12_DIR"])("real B12 answers", () => {
  const dir = process.env["B12_DIR"] ?? "";
  const read = (name: string) =>
    decodeVisionResult(
      { extractionProtocol: "label-extraction/1" } as never,
      JSON.parse(readFileSync(join(dir, name), "utf8")).raw,
    ).candidate as LabelImageCandidate;
  const files = readdirSync(dir).sort();
  for (const formats of [INDIA, undefined]) {
    const setup = assemblySetup(files.map(read));
    setup.join.manifest.evidencePolicy = "label-image-first/7";
    if (formats) {
      const policy = keywordPolicyFor(formats);
      for (const source of setup.join.manifest.sources)
        if (source.kind === "image") source.task.input.selection.policy = policy;
      for (const entry of setup.entries.values())
        if (entry.kind === "image") entry.record.input.selection.policy = policy;
    }
    const merged = mergeLabelProduct(setup.join.manifest, { entries: [...setup.entries.values()] });
    console.log(
      "REAL",
      formats ? "IN" : "US",
      merged.status,
      merged.codes,
      JSON.stringify(merged.warnings),
    );
  }
});
