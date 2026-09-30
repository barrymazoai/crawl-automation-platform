import type { TextInput } from "@crawl-automation/v3-contracts";
import type { AnchoredExtraction } from "./anchored-schema.js";

/** A synthetic prepared-text task; no saved page, OCR engine or model is needed. */
export function anchoredInput(text: string, changes: Partial<TextInput> = {}): TextInput {
  return {
    schemaVersion: 1,
    requestId: "request",
    observationId: "observation",
    brandId: "brand",
    sourceId: "source",
    listingId: "listing",
    variantId: null,
    operationId: "text-operation",
    module: "codex.text",
    implementationVersion: "codex-text/2",
    policyVersion: "anchored/2",
    resultSchemaVersion: 2,
    configFingerprint: "a".repeat(64),
    inputFingerprint: "b".repeat(64),
    source: {
      kind: "prepared",
      document: {
        schemaVersion: 1,
        artifactId: "document",
        observationId: "observation",
        sourceId: "source",
        listingId: "listing",
        variantId: null,
        kind: "result-json",
        mediaType: "application/json",
        sha256: "c".repeat(64),
        byteSize: 100,
        objectKey: "prepared/document.json",
        producer: { operationId: "prepare", module: "page.prepare", implementationVersion: "1" },
      },
    },
    range: { start: 0, end: text.length },
    ...changes,
  };
}

export const anchor = (line: number, text: string) => ({ fromLine: line, toLine: line, text });

export function quoteAt(text: string, value: string) {
  const start = text.indexOf(value);
  if (start < 0) {
    throw new Error("fixture quote is not in its text");
  }
  return { text: value, start, end: start + value.length };
}

export function anchoredAnswer(): { text: string; wire: AnchoredExtraction } {
  const text = [
    "Supplement Facts",
    "Serving Size 1 Capsule",
    "Vitamin C 10 mg 11%",
    "Other Ingredients: Rice flour, cellulose",
    "† Daily Value not established.",
  ].join("\n");
  const wire: AnchoredExtraction = {
    formula: {
      servingSize: anchor(2, "Serving Size 1 Capsule"),
      nutrients: [
        { name: anchor(3, "Vitamin C"), amount: anchor(3, "10 mg"), dailyValue: anchor(3, "11%") },
      ],
    },
    ingredients: {
      items: ["Rice flour", "cellulose"].map((text) => ({
        quote: anchor(4, text),
        role: "other",
        parentNutrientIndex: null,
      })),
    },
    excluded: [
      { quote: anchor(1, "Supplement Facts"), reason: "heading" },
      { quote: anchor(4, "Other Ingredients:"), reason: "heading" },
      { quote: anchor(5, "† Daily Value not established."), reason: "footnote" },
    ],
    issues: [],
  };
  return { text, wire };
}
