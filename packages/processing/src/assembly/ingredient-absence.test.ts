import { describe, expect, it } from "vitest";
import { LabelCollectedProductSchema } from "@crawl-automation/v3-contracts";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { decodeIngredientPresenceAnswer } from "../vision/protocol/label-ingredient-presence.js";
import {
  explicitNoneWire,
  printed,
  savedPresenceAnswer,
} from "../vision/protocol/ingredient-presence-fixture.js";

function absenceCandidate(nutrientOnly = false) {
  const wire = explicitNoneWire();
  if (nutrientOnly) {
    defined(wire.label.formula?.columns[0]).rows = [
      {
        kind: "nutrient",
        name: printed("Vitamin C"),
        amount: printed("100 mg"),
        amountStatus: "printed",
        dailyValue: printed("111%"),
        parentRowIndex: null,
      },
    ];
  }
  return decodeIngredientPresenceAnswer(savedPresenceAnswer(wire)).candidate;
}

describe("collecting labels with explicit no-other-ingredients evidence", () => {
  it.each([false, true])(
    "collects and cold-reads without inventing ingredients (nutrient-only: %s)",
    async (nutrientOnly) => {
      const candidate = absenceCandidate(nutrientOnly);
      const setup = assemblySetup([candidate]);
      setup.join.manifest.evidencePolicy = "label-image-first/6";
      const signal = new AbortController().signal;
      const assembled = await setup.assembly.run(setup.join, signal);
      expect(assembled.status).toBe("ready");
      const input = { join: setup.join, evidenceKey: assembled.evidenceKey };
      expect((await setup.collector.run(input, signal)).status).toBe("collected");
      const record = LabelCollectedProductSchema.parse(
        await setup.registry.read(setup.join.manifest.operationId),
      );
      expect(record.otherIngredients).toBeNull();
      expect(record.ingredients).toHaveLength(nutrientOnly ? 0 : 1);
      expect(record.provenance[0]?.candidate).toEqual(candidate);
      expect((await setup.cold().collector.run(input, signal)).status).toBe("collected");
      expect(setup.registry.append).toHaveBeenCalledTimes(1);
      const forged = structuredClone(record);
      const image = defined(forged.provenance[0]);
      if (image.kind === "image") {
        delete image.candidate.ingredientDeclaration;
      }
      if (nutrientOnly) {
        expect(LabelCollectedProductSchema.safeParse(forged).success).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "rejects a sibling's printed ingredient list in either source order (%s)",
    async (reverse) => {
      const none = absenceCandidate();
      const present = structuredClone(none);
      delete present.ingredientDeclaration;
      present.otherIngredients = {
        heading: printed("Other Ingredients"),
        items: [printed("water")],
      };
      const setup = assemblySetup(reverse ? [present, none] : [none, present]);
      setup.join.manifest.evidencePolicy = "label-image-first/6";
      const assembled = await setup.assembly.run(setup.join, new AbortController().signal);
      expect(assembled.status).toBe("review");
      expect(setup.registry.append).not.toHaveBeenCalled();
    },
  );

  it("does not collect a cut-off label even with complete Facts and claimed complete ingredients", async () => {
    const candidate = absenceCandidate();
    defined(candidate.ingredientDeclaration).wholeLabelVisible = false;
    const setup = assemblySetup([candidate]);
    setup.join.manifest.evidencePolicy = "label-image-first/6";
    expect((await setup.assembly.run(setup.join, new AbortController().signal)).status).toBe(
      "review",
    );
  });
});
