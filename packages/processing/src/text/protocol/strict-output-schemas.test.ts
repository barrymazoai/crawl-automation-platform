import { describe, expect, it } from "vitest";
import { labelVisionOutputSchema } from "../../vision/protocol/label-vision.js";
import { labelVisionOutputV2Schema } from "../../vision/protocol/label-vision-v2.js";
import { labelTextOutputSchema, legacyLabelTextOutputSchema } from "./label-instructions.js";

/**
 * OpenAI strict structured output refuses a schema whose object lists a property it does not require
 * (2026-09-30: label-text/5 sent an optional `purpose`, and every text call failed with invalid_json_schema).
 */
function optionalProperties(schema: unknown, path = "$"): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => optionalProperties(item, `${path}[${index}]`));
  }
  if (!schema || typeof schema !== "object") {
    return [];
  }
  const node = schema as { properties?: Record<string, unknown>; required?: string[] };
  const own = node.properties
    ? Object.keys(node.properties)
        .filter((key) => !(node.required ?? []).includes(key))
        .map((key) => `${path}.${key}`)
    : [];
  return [
    ...own,
    ...Object.entries(schema).flatMap(([key, value]) =>
      optionalProperties(value, `${path}.${key}`),
    ),
  ];
}

describe("answer formats sent to the model", () => {
  it.each([
    ["label-text/5", labelTextOutputSchema],
    ["label-text/3-4", legacyLabelTextOutputSchema],
    ["label-vision", labelVisionOutputSchema],
    ["label-vision v2", labelVisionOutputV2Schema],
  ])("%s requires every property (OpenAI strict output)", (_name, schema) => {
    expect(optionalProperties(schema)).toEqual([]);
  });
});
