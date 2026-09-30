import { describe, expect, it, vi } from "vitest";
import { extractLabelJsonWithRepair } from "./label-extraction.js";

const valid = JSON.stringify({
  panelType: "supplement_facts",
  factsImages: [0],
  servingSize: "1 capsule",
  servingsPerContainer: "30",
  activeIngredients: [{
    raw: "Vitamin C",
    substance: "Vitamin C",
    form: null,
    category: "vitamins",
    amount: "100 mg",
    dv: "111%",
    indent: 0,
  }],
  otherIngredients: [],
  unreadable: [],
});

describe("extractLabelJsonWithRepair", () => {
  it("repairs an invalid cached payload once", async () => {
    const runModel = vi.fn().mockResolvedValue(valid);
    const verdict = await extractLabelJsonWithRepair({
      prompt: "extract",
      tag: "label-X",
      runModel,
      stored: { raw: '{"category":vitamins}', parsed: null },
    });

    expect(runModel).toHaveBeenCalledOnce();
    expect(runModel.mock.calls[0]?.[0].tag).toBe("label-X-repair");
    expect(verdict.parsed?.activeIngredients?.[0]?.category).toBe("vitamins");
  });

  it("reuses a valid cached payload without another model call", async () => {
    const runModel = vi.fn();
    const verdict = await extractLabelJsonWithRepair({
      prompt: "extract",
      tag: "label-X",
      runModel,
      stored: { raw: valid, parsed: null },
    });

    expect(runModel).not.toHaveBeenCalled();
    expect(verdict.parsed?.panelType).toBe("supplement_facts");
  });
});
