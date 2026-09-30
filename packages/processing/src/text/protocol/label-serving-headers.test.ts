import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { exclusionCodes } from "./label-exclusions.js";

type Reason = LabelTextCandidate["exclusions"][number]["reason"];
const headers = [
  { name: "Serving Size", field: "servingSize", value: "1 Scoop (11.9 g)" },
  { name: "Servings Per Container", field: "servingsPerContainer", value: "30" },
] as const;

function checkHeader(header: (typeof headers)[number], reason: Reason, captured: string | null) {
  const text = `${header.name}: ${header.value}`;
  const quote = { text, start: 0, end: text.length };
  const field = captured
    ? { text: captured, start: header.name.length + 2, end: text.length }
    : null;
  const candidate: LabelTextCandidate = {
    codec: "label-extraction/1",
    formula: { servingSize: null, servingsPerContainer: null, columns: [], [header.field]: field },
    otherIngredients: null,
    formulaComplete: false,
    ingredientsComplete: false,
    exclusions: [{ reason, quote }],
    issues: [],
  };
  return exclusionCodes({ text, candidate, policyVersion: "label-text/5" });
}

describe.each(headers)("serving header $name", (header) => {
  it.each(["heading", "metadata", "footnote", "noise"] as const)(
    "accepts %s only when the entire value is already captured",
    (reason) => {
      expect(checkHeader(header, reason, header.value)).toEqual([]);
      expect(checkHeader(header, reason, ` ${header.value.replaceAll(" ", "  ")} `)).toEqual([]);
      for (const captured of [null, "1", "60", `${header.value} extra`]) {
        expect(checkHeader(header, reason, captured)).toEqual(["LABEL.COVERAGE_UNCERTAIN"]);
      }
    },
  );

  it("does not waive a marketing exclusion even when its value is captured", () => {
    expect(checkHeader(header, "marketing", header.value)).toEqual(["LABEL.COVERAGE_UNCERTAIN"]);
  });
});
