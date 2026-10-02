import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  assessLabelCandidate,
  completeLabelSections,
  isCompleteLabelImage,
} from "@crawl-automation/v3-contracts";
import { imageSource } from "../../testing/label-sources.js";
import { decodeLabelImage } from "./label-vision.js";
import { decodeLabelImageV2 } from "./label-vision-v2.js";
import { decodeVisionResult } from "./vision-protocol.js";
import {
  decodeIngredientPresenceAnswer,
  labelIngredientPresencePrompt,
  labelIngredientPresenceOutputSchema,
} from "./label-ingredient-presence.js";
import {
  explicitNoneWire,
  savedPresenceAnswer,
  savedOreganoLabel,
  printed,
} from "./ingredient-presence-fixture.js";

describe("explicit absence of a separately printed ingredients section", () => {
  it("pins the new prompt and schema so further changes require a new protocol version", () => {
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(digest(labelIngredientPresencePrompt)).toBe(
      "b46a5880945a39229db3359fe073892d421da131e5536caa9010366f6b5d1e69",
    );
    expect(digest(JSON.stringify(labelIngredientPresenceOutputSchema))).toBe(
      "1e41b52ed05b2c01ea54ca569ea6c1caef65a20407a62f262994c6737ef6bc4a",
    );
  });
  it("keeps the saved B08QDNPQPK /1 answer and its original Review under current decoding", () => {
    const label = savedOreganoLabel();
    const raw = JSON.stringify(label);
    const { source } = imageSource(label, 0);
    expect(decodeLabelImage(raw)).toMatchObject({
      candidate: label,
      status: "review",
      codes: ["LABEL.INGREDIENTS_INCOMPLETE", "LABEL.COMPLETENESS_CONFLICT"],
    });
    expect(decodeVisionResult(source.task.input, raw)).toMatchObject({
      candidate: label,
      status: "review",
      code: "VISION.LABEL_INGREDIENTS_INCOMPLETE",
    });
    expect(isCompleteLabelImage({ kind: "image", candidate: label })).toBe(false);
    expect(completeLabelSections(label)).toBeNull();
  });

  it("does not promote a null /2 section or an old answer wrapped without new observations", () => {
    const label = savedOreganoLabel();
    expect(
      decodeLabelImageV2(
        JSON.stringify({
          codec: "label-visual-wire/2",
          label,
          otherIngredientsBlock: null,
        }),
      ).status,
    ).toBe("review");
    const wire = explicitNoneWire();
    wire.label = label;
    expect(decodeIngredientPresenceAnswer(savedPresenceAnswer(wire)).status).toBe("review");
  });

  it("accepts explicit whole-label absence by default, retaining the printed carrier oil in Facts", () => {
    const result = decodeIngredientPresenceAnswer(savedPresenceAnswer());
    expect(result).toMatchObject({ status: "candidate", codes: [] });
    expect(result.candidate.formula).toEqual(savedOreganoLabel().formula);
    expect(result.candidate.otherIngredients).toBeNull();
    expect(result.candidate.ingredientDeclaration?.state).toBe("none_printed");
    expect(isCompleteLabelImage({ kind: "image", candidate: result.candidate })).toBe(true);
    expect(completeLabelSections(result.candidate)).toEqual(result.candidate);
  });

  it("records a disabled policy and keeps the result Review on repeated decoding", () => {
    const raw = savedPresenceAnswer(explicitNoneWire(), false);
    const result = decodeIngredientPresenceAnswer(raw);
    expect(result.status).toBe("review");
    expect(result.codes).toContain("LABEL.INGREDIENTS_INCOMPLETE");
    expect(assessLabelCandidate(result.candidate).status).toBe("review");
    expect(decodeIngredientPresenceAnswer(raw)).toEqual(result);
  });

  it.each(["not_fully_visible", "unreadable", "none_printed"] as const)(
    "rejects %s when the whole label was not seen, even if the model claims completeness",
    (state) => {
      const wire = explicitNoneWire();
      wire.otherIngredientsState = state;
      wire.wholeLabelVisible = false;
      const result = decodeIngredientPresenceAnswer(savedPresenceAnswer(wire));
      expect(result.status).toBe("review");
      expect(isCompleteLabelImage({ kind: "image", candidate: result.candidate })).toBe(false);
    },
  );

  it("retains unreadable/cropped issues and refuses to launder them through section selection", () => {
    const wire = explicitNoneWire();
    wire.label.issues = [{ code: "UNREADABLE", detail: "Right edge of label is cut off" }];
    const result = decodeIngredientPresenceAnswer(savedPresenceAnswer(wire));
    expect(result.status).toBe("review");
    expect(completeLabelSections(result.candidate)).toBeNull();
  });

  it("requires explicit observation fields and never accepts new declarations in old protocols", () => {
    const candidate = decodeIngredientPresenceAnswer(savedPresenceAnswer()).candidate;
    expect(() => decodeLabelImage(JSON.stringify(candidate))).toThrow();
    const { wholeLabelVisible: _coverage, ...wire } = explicitNoneWire();
    const raw = JSON.parse(savedPresenceAnswer());
    raw.raw = JSON.stringify(wire);
    expect(() => decodeIngredientPresenceAnswer(JSON.stringify(raw))).toThrow();
  });

  it("still transcribes a present list mechanically and rejects a contradictory none claim", () => {
    const wire = explicitNoneWire();
    wire.label.otherIngredients = {
      heading: printed("Other Ingredients"),
      items: [printed("oil")],
    };
    wire.otherIngredientsBlock = printed("olive oil, water");
    expect(decodeIngredientPresenceAnswer(savedPresenceAnswer(wire)).status).toBe("review");
    wire.otherIngredientsState = "present";
    const result = decodeIngredientPresenceAnswer(savedPresenceAnswer(wire));
    expect(result.status).toBe("candidate");
    expect(result.candidate.otherIngredients?.items).toEqual([
      printed("olive oil"),
      printed("water"),
    ]);
  });
});
