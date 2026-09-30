import { describe, expect, it } from "vitest";
import { ArtifactRefSchema, type ArtifactRef } from "./artifacts.js";
import type { LabelImageCandidate } from "./label-extraction.js";
import { gncLabelFixture } from "./label.fixture.js";
import { LabelCollectedProductSchema, projectLabelProductCandidate } from "./label-product.js";
import { VisionRecordSchema } from "./vision.js";

const vitamin = "Vitamin D (as cholecalciferol)";
const vitaminD3 = "Vitamin D (as D3 cholecalciferol)";
const wordingCode = "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS";
const field = (text: string) => ({ text, evidence: text });
const hash = "a".repeat(64);
const observation = {
  schemaVersion: 1,
  requestId: "request",
  observationId: "observation",
  brandId: "brand",
  sourceId: "source",
  listingId: "listing",
  variantId: null,
};

function candidate(name = vitamin, amount = "10 mg"): LabelImageCandidate {
  const value = gncLabelFixture();
  const column = value.formula?.columns[0];
  if (!column) {
    throw new Error("Fixture requires a column");
  }
  column.rows = column.rows.slice(0, 2).map((row, index) => ({
    ...row,
    name: field(index === 0 ? name : "Apoaequorin"),
    amount: field(index === 0 ? "50 mcg" : amount),
    dailyValue: index === 0 ? field("250%") : null,
  }));
  return value;
}

/** Synthetic receipts, with distinct image, response and completion identities. */
function artifact(operationId: string, name: string, image = false): ArtifactRef {
  return ArtifactRefSchema.parse({
    schemaVersion: 1,
    artifactId: `${operationId}-${name}`,
    observationId: observation.observationId,
    sourceId: observation.sourceId,
    listingId: observation.listingId,
    variantId: null,
    kind: image ? "source-image" : "result-json",
    mediaType: image ? "image/png" : "application/json",
    sha256: hash,
    byteSize: 1,
    objectKey: `synthetic/${operationId}/${name}`,
    producer: {
      operationId,
      module: image ? "file.acquire" : "codex.vision",
      implementationVersion: image ? "1" : "vision/2",
    },
  });
}

function source(value: LabelImageCandidate, index: number) {
  const id = `image-${index}`;
  const record = VisionRecordSchema.parse({
    schemaVersion: 2,
    codec: "vision-result/2",
    storageId: "synthetic/1",
    status: "candidate",
    configFingerprint: hash,
    input: {
      operationId: id,
      extractionProtocol: "label-extraction/1",
      selection: {
        schemaVersion: 1,
        observation,
        image: artifact(id, "image", true),
        ocrOperationId: `ocr-${index}`,
        ocrTextSha256: hash,
        policy: { version: "label-keywords/1", keywords: ["Supplement Facts"] },
        policyFingerprint: hash,
        status: "matched",
        matchedKeywords: ["Supplement Facts"],
      },
    },
    result: artifact(id, "response"),
    completion: artifact(id, "completion"),
  });
  return { id, kind: "image" as const, record, candidate: value };
}

function collected(first = candidate(), second = candidate(vitaminD3)) {
  const selected = projectLabelProductCandidate("image-0", first);
  return {
    schemaVersion: 3,
    codec: "collected-product/3",
    evidencePolicy: "label-image-first/1",
    operationId: "collected",
    observation,
    assembly: { objectKey: "synthetic/assembly", sha256: hash, byteSize: 1 },
    ...selected,
    ingredients: (selected.otherIngredients?.items ?? []).map((name) => ({
      name,
      role: "other",
      amount: null,
      columnIndex: null,
      rowIndex: null,
      parentRowIndex: null,
    })),
    warnings: [{ id: "image-1", code: wordingCode }],
    provenance: [source(first, 0), source(second, 1)],
  };
}

describe("saved label source agreement", () => {
  it.each([
    [vitamin, vitaminD3],
    [vitaminD3, vitamin],
  ])("validates Vitamin D wording and preserves the selected source: %s / %s", (first, second) => {
    const record = collected(candidate(first), candidate(second));
    expect(LabelCollectedProductSchema.parse(record)).toEqual(record);
    expect(record.formula?.columns[0]?.rows[0]?.name).toMatchObject({
      text: first,
      sourceId: "image-0",
    });
  });

  it.each([
    "label-image-first/1",
    "label-image-first/2",
    "label-image-first/3",
    "label-image-first/4",
  ])("uses shared agreement with %s", (evidencePolicy) => {
    expect(LabelCollectedProductSchema.safeParse({ ...collected(), evidencePolicy }).success).toBe(
      true,
    );
  });

  it("refuses a changed amount even when the wording warning is present", () => {
    const record = collected(candidate(), candidate(vitaminD3, "20 mg"));
    expect(LabelCollectedProductSchema.safeParse(record).success).toBe(false);
  });

  it.each(["Vitamin K (as cholecalciferol)", "Vitamin D (as ergocalciferol)"])(
    "refuses a different base name or non-subset clause: %s",
    (name) => {
      expect(
        LabelCollectedProductSchema.safeParse(collected(candidate(), candidate(name))).success,
      ).toBe(false);
    },
  );

  it("requires the warning on the differing source", () => {
    const record = collected();
    expect(LabelCollectedProductSchema.safeParse({ ...record, warnings: [] }).success).toBe(false);
    expect(
      LabelCollectedProductSchema.safeParse({
        ...record,
        warnings: [{ id: "image-0", code: wordingCode }],
      }).success,
    ).toBe(false);
  });

  it("compares against the selected source even if provenance arrives in reverse order", () => {
    const record = collected();
    record.provenance.reverse();
    expect(LabelCollectedProductSchema.safeParse(record).success).toBe(true);
  });

  it("validates ingredient case and prefix wording while refusing genuinely different items", () => {
    const first = candidate();
    const second = candidate();
    if (!first.otherIngredients || !second.otherIngredients) {
      throw new Error("Fixture requires ingredients");
    }
    first.otherIngredients.items = [field("Microcrystalline cellulose"), field("casein peptones")];
    second.otherIngredients.items = [
      field("microcrystalline cellulose"),
      field("contains 2% or less of: casein peptones"),
    ];
    expect(LabelCollectedProductSchema.safeParse(collected(first, second)).success).toBe(true);
    second.otherIngredients.items = [field("casein"), field("potassium citrate")];
    expect(LabelCollectedProductSchema.safeParse(collected(first, second)).success).toBe(false);
  });
});
