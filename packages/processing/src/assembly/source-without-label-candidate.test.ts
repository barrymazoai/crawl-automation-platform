import { describe, expect, it } from "vitest";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { labelCandidate } from "../testing/assembly-fixture.js";
import { collectBoth, merge, mergeSetup } from "../testing/merge-fixture.js";
import { decodeTextResult } from "../text/protocol/text-protocol.js";

const skipped = { id: "a-text", code: "LABEL_PRODUCT.SOURCE_WITHOUT_LABEL" };

function emptyLabel(): LabelImageCandidate {
  const text = "Supports cognitive health";
  return {
    codec: "label-extraction/1",
    formula: null,
    otherIngredients: null,
    formulaComplete: false,
    ingredientsComplete: false,
    exclusions: [{ quote: { text, evidence: text }, reason: "marketing" }],
    issues: [{ code: "FORMULA_MISSING", detail: "No label facts are printed in this source." }],
  };
}

describe("missing-label candidate assessment", () => {
  it("maps the text model's FORMULA_MISSING outcome to TEXT.LABEL_CORE_MISSING", async () => {
    const candidate = emptyLabel();
    const setup = await mergeSetup([labelCandidate()], candidate);
    const wire = {
      ...candidate,
      exclusions: [
        {
          quote: { fromLine: 1, toLine: 1, text: "Supports cognitive health" },
          reason: "marketing",
        },
      ],
    };
    expect(() =>
      decodeTextResult(setup.text.record.input, setup.text.fullText, JSON.stringify(wire)),
    ).toThrowError(expect.objectContaining({ code: "TEXT.LABEL_CORE_MISSING" }));
  });

  it("skips a verified empty text candidate and retains its original assessment and provenance", async () => {
    const setup = await mergeSetup([labelCandidate()], emptyLabel());
    const record = await collectBoth(setup);
    expect(record.warnings).toEqual(
      expect.arrayContaining([skipped, { id: setup.text.id, code: "LABEL.CORE_MISSING" }]),
    );
    expect(record.provenance.find((entry) => entry.id === setup.text.id)?.candidate).toEqual(
      setup.text.candidate,
    );
  });

  it("keeps the original assessment when an empty candidate is the only source", async () => {
    const setup = await mergeSetup([labelCandidate()], emptyLabel());
    setup.join.manifest.sources = setup.join.manifest.sources.filter(
      (source) => source.kind === "text",
    );
    expect(merge(setup, [setup.text])).toMatchObject({
      status: "review",
      codes: expect.arrayContaining(["LABEL.CORE_MISSING"]),
      warnings: [],
    });
  });

  it("does not hide an additional quality failure on an empty candidate", async () => {
    const text = emptyLabel();
    text.issues.push({ code: "UNREADABLE", detail: "Printed evidence cannot be read." });
    const setup = await mergeSetup([labelCandidate()], text);
    expect(merge(setup)).toMatchObject({
      status: "review",
      codes: ["LABEL.CORE_MISSING", "LABEL.EVIDENCE_UNCERTAIN"],
      warnings: [],
    });
  });

  it("keeps a text candidate with a formula and failed completeness checks blocking", async () => {
    const text = labelCandidate();
    text.formulaComplete = false;
    const setup = await mergeSetup([labelCandidate()], text);
    expect(merge(setup)).toMatchObject({
      status: "review",
      codes: ["LABEL.FORMULA_INCOMPLETE"],
      warnings: [],
    });
  });
});
