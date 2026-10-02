import { describe, expect, it } from "vitest";
import type { EnrichmentCandidate } from "@crawl-automation/v3-contracts";
import { decodeEnrichment, ENRICHMENT_RESPONSE_BYTES } from "./decode.js";
import type { EnrichmentContent } from "./protocol.js";

const input: EnrichmentContent["input"] = {
  protocol: "product-enrichment/2",
  title: "Vitamin D 60 capsules 25 mcg",
  label: { servingSize: "1 capsule", ingredients: ["Rice flour"] },
};
const candidate: EnrichmentCandidate = {
  unifiedName: "Vitamin D 25 mcg",
  baseName: "Vitamin D",
  form: "capsule",
  variant: { count: 60, size: null, flavor: null, strength: "25 mcg" },
  healthFunctions: [],
  confidence: 0.95,
  notes: null,
};

const decode = (value: unknown, evidence = input) =>
  decodeEnrichment(JSON.stringify(value), evidence);

describe("enrichment refusals", () => {
  it("preserves grounded output and null optional fields", () => {
    expect(decode(candidate)).toEqual(candidate);
  });
  it.each([
    ["not-json", { reason: "schema", issues: [{ path: [], code: "invalid_json" }] }],
    [
      JSON.stringify({ ...candidate, confidence: 2 }),
      { reason: "schema", issues: [{ path: ["confidence"], code: "too_big" }] },
    ],
    ["é".repeat(ENRICHMENT_RESPONSE_BYTES / 2 + 1), { reason: "too-large" }],
  ])("retains a JSON-safe diagnostic for malformed or oversized output", (answer, details) => {
    expect(() => decodeEnrichment(answer as string, input)).toThrow(
      expect.objectContaining({ code: "ENRICH.OUTPUT_INVALID", details }),
    );
  });
  it.each(["unifiedName", "baseName"])("still refuses unprinted words in %s", (field) => {
    expect(() => decode({ ...candidate, [field]: "Vitamin D miracle" })).toThrow(
      expect.objectContaining({
        code: "ENRICH.OUTPUT_INVALID",
        details: { reason: `unsupported-word:${field}:miracle` },
      }),
    );
  });
  it("accepts exactly 64 KB, with the same byte boundary used by answer retention", () => {
    const response = JSON.stringify(candidate);
    expect(decodeEnrichment(response.padEnd(ENRICHMENT_RESPONSE_BYTES, " "), input)).toEqual(
      candidate,
    );
  });
  it("does not let model-supplied warnings bypass grounding", () => {
    expect(() => decode({ ...candidate, warnings: ["form-not-printed:liquid"] })).toThrow(
      expect.objectContaining({
        code: "ENRICH.OUTPUT_INVALID",
        details: { reason: "schema", issues: [{ path: [], code: "unrecognized_keys" }] },
      }),
    );
  });
  it("retains nested schema issue paths", () => {
    expect(() => decode({ ...candidate, variant: { ...candidate.variant, count: "60" } })).toThrow(
      expect.objectContaining({
        details: {
          reason: "schema",
          issues: [{ path: ["variant", "count"], code: "invalid_type" }],
        },
      }),
    );
  });
  it.each([
    ["Cures cancer", "unsupported-word:healthFunctions:cures"],
    ["no sugar", "health-function-not-printed"],
  ])("refuses an unsupported health claim: %s", (claim, reason) => {
    const evidence = { ...input, label: ["Supports bones", "no artificial color", "sugar"] };
    expect(() => decode({ ...candidate, healthFunctions: [claim] }, evidence)).toThrow(
      expect.objectContaining({ code: "ENRICH.OUTPUT_INVALID", details: { reason } }),
    );
  });
  it("preserves an explicitly printed health claim", () => {
    const value = { ...candidate, healthFunctions: ["Supports BONES"] };
    expect(decode(value, { ...input, label: "Supports bones" })).toEqual(value);
  });
});

describe("optional enrichment grounding", () => {
  it.each(["flavor", "strength"] as const)("drops only unsupported %s and records why", (field) => {
    const value = { ...candidate, variant: { ...candidate.variant, [field]: "invented" } };
    const result = decode(value);
    expect(result.variant).toEqual({ ...candidate.variant, [field]: null });
    expect(result.warnings).toEqual([`unsupported-word:variant.${field}:invented`]);
    expect(result.unifiedName).toBe(candidate.unifiedName);
  });
  it("retains explicit flavor and strength from label text", () => {
    const value = { ...candidate, variant: { ...candidate.variant, flavor: "Orange" } };
    expect(decode(value, { ...input, label: ["Orange", "1 capsule"] })).toEqual(value);
  });
  it("keeps warnings even when model notes already fill the allowed length", () => {
    const value = { ...candidate, form: "liquid", notes: "a".repeat(1000) };
    const result = decode(value);
    expect(result.notes).toBe(value.notes);
    expect(result.warnings).toEqual(["form-not-printed:liquid"]);
  });
});

describe("package quantities", () => {
  it("uses an identified website variant count without deriving it from label servings", () => {
    const value = {
      ...candidate,
      unifiedName: "Vitamin D",
      variant: { ...candidate.variant, count: 100, strength: null },
    };
    const evidence = {
      ...input,
      title: "Vitamin D",
      websiteVariant: {
        protocol: "website-variant/1" as const,
        title: "100 ct",
        options: ["VegCaps: 100 ct"],
      },
    };
    expect(decode(value, evidence).variant.count).toBe(100);
    expect(
      decode(value, {
        ...evidence,
        websiteVariant: { ...evidence.websiteVariant, title: "31 servings", options: [] },
      }).variant.count,
    ).toBeNull();
    expect(decode(value, { ...evidence, title: "Vitamin D 60 capsules" }).variant.count).toBeNull();
    expect(
      decode(value, {
        ...evidence,
        websiteVariant: { ...evidence.websiteVariant, title: "100 ct / 200 ct", options: [] },
      }).variant.count,
    ).toBeNull();
  });
  it("uses explicit website package size but never the label's serving size", () => {
    const value = {
      ...candidate,
      variant: { ...candidate.variant, size: { value: 500, unit: "mL" } },
    };
    const evidence = {
      ...input,
      websiteVariant: { protocol: "website-variant/1" as const, title: "500mL", options: [] },
    };
    expect(decode(value, evidence).variant.size).toEqual(value.variant.size);
    expect(
      decode(value, {
        ...evidence,
        websiteVariant: { ...evidence.websiteVariant, title: null },
        label: "500mL per serving; 1 capsule",
      }).variant.size,
    ).toBeNull();
  });
  it.each(["Vitamin D (31 Servings)", "Vitamin D 31 servings"])(
    "does not conflate servings with a package unit count: %s",
    (title) => {
      const value = {
        ...candidate,
        unifiedName: "Vitamin D",
        variant: { ...candidate.variant, count: 31, strength: null },
      };
      expect(decode(value, { ...input, title })).toEqual({
        ...value,
        variant: { ...value.variant, count: null },
        warnings: ["count-not-in-title"],
      });
    },
  );
  it.each([
    "Vitamin D 60 capsules / 120 capsules 25 mcg",
    "Vitamin D 160 capsules 25 mcg",
    "Vitamin D 1.60 capsules 25 mcg",
    "Vitamin D 25 mcg",
  ])("nulls missing or ambiguous title counts: %s", (title) => {
    const result = decode(candidate, { ...input, title });
    expect(result.variant.count).toBeNull();
    expect(result.warnings).toContain("count-not-in-title");
  });
  it.each(["Vitamin D 60ct 25 mcg", "Vitamin D 60 capsules (30 Servings) 25 mcg"])(
    "retains explicit package unit counts: %s",
    (title) => {
      expect(decode(candidate, { ...input, title })).toEqual(candidate);
    },
  );
  it.each([
    ["15 fl. oz. bottle", 15, "fl oz"],
    ["15fl oz", 15, "fl oz"],
    ["15.0 FL OZ", 15, "fl oz"],
    ["500mL", 500, "mL"],
  ])("accepts explicitly printed size despite spacing: %s", (title, value, unit) => {
    const answer = { ...candidate, variant: { ...candidate.variant, size: { value, unit } } };
    expect(decode(answer, { ...input, title: `${input.title} ${title}` }).variant.size).toEqual({
      value,
      unit,
    });
  });
  it.each(["15 oz", "1.5 oz", "5 ozones", "5 mg", "no package size"])(
    "does not accept an unprinted size through substring matching: %s",
    (title) => {
      const size = { value: 5, unit: "oz" };
      const value = { ...candidate, variant: { ...candidate.variant, size } };
      const evidence = { ...input, title: `${input.title} ${title}`, label: "5 oz" };
      const result = decode(value, evidence);
      expect(result.variant.size).toBeNull();
      expect(result.warnings).toContain("size-not-in-title");
    },
  );
  it("never uses label serving quantities as package counts or sizes", () => {
    const value = {
      ...candidate,
      variant: { ...candidate.variant, count: 1, size: { value: 1, unit: "capsule" } },
    };
    const result = decode(value);
    expect(result.variant).toMatchObject({ count: null, size: null });
    expect(result.warnings).toEqual(["count-not-in-title", "size-not-in-title"]);
  });
});

describe("dosage form", () => {
  it("retains Burn2o-style data with warnings for inferred form and count", () => {
    const evidence = {
      ...input,
      title: "Burn2o - Fiery Punch - 15 fl oz. (31 Servings)",
      label: { servingSize: "1 Tablespoon (15 mL)" },
    };
    const value = {
      ...candidate,
      unifiedName: "Burn2o Fiery Punch",
      baseName: "Burn2o",
      form: "liquid",
      variant: {
        count: 31,
        size: { value: 15, unit: "fl oz" },
        flavor: "Fiery Punch",
        strength: null,
      },
    };
    expect(decode(value, evidence)).toEqual({
      ...value,
      form: "unknown",
      variant: { ...value.variant, count: null },
      warnings: ["count-not-in-title", "form-not-printed:liquid"],
    });
  });
  it.each(["500mL", "15 fl. oz.", "1 Tablespoon"])("does not infer liquid from %s", (volume) => {
    const evidence = { ...input, title: `${input.title} ${volume}` };
    const result = decode({ ...candidate, form: "liquid" }, evidence);
    expect(result.form).toBe("unknown");
    expect(result.warnings).toEqual(["form-not-printed:liquid"]);
  });
  it.each([
    ["liquid", "1 Tablespoon"],
    ["liquid", "Mix powder with 15 mL water"],
    ["bar", "barley"],
    ["gummy", "gumminess"],
  ])("leaves unsupported %s unknown, retaining the rest of the enrichment", (form, label) => {
    const result = decode({ ...candidate, form }, { ...input, label });
    expect(result.form).toBe("unknown");
    expect(result.warnings).toContain(`form-not-printed:${form}`);
  });
  it.each([
    ["gummy", "gummies"],
    ["drops", "drop"],
    ["tablet", "tablets"],
    ["liquid", "oz liquid"],
    ["other", ""],
    ["unknown", ""],
  ])("retains supported forms and unknown values: %s", (form, label) => {
    expect(decode({ ...candidate, form }, { ...input, label }).form).toBe(form);
  });
});
