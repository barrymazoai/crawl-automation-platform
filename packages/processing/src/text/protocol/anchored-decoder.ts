import {
  TextCandidateV1Schema,
  TextCandidateV2Schema,
  assertTextQuotes,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import type { z } from "zod";
import { textFailure } from "../errors.js";
import { isAllowedAnchoredExclusion } from "./anchored-exclusions.js";
import {
  assertIngredientBoundaries,
  assertIngredientRoles,
  type AnchoredItem,
} from "./anchored-ingredients.js";
import { AnchoredExtractionSchema, type AnchoredExtraction } from "./anchored-schema.js";
import { coversEveryPrintedCharacter } from "./coverage.js";
import { evidenceLines, type Quote } from "./evidence-lines.js";
import { resolveAnchor, type Anchor } from "./resolve-anchor.js";

type CandidateV1 = z.infer<typeof TextCandidateV1Schema>;
type CandidateV2 = z.infer<typeof TextCandidateV2Schema>;

const failed = (code: Parameters<typeof textFailure>[0]) => textFailure(code, "executed");

/** Reads a source-text answer (candidate v1, or anchored/2) and checks every quote against the text. */
export function decodeTextResponse(
  input: TextInput,
  text: string,
  raw: string,
): CandidateV1 | CandidateV2 {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw failed("TEXT.MODEL_SCHEMA");
  }
  if (input.resultSchemaVersion === 1) {
    return decodeCandidateV1(input, text, json);
  }
  const parsed = AnchoredExtractionSchema.safeParse(json);
  if (!parsed.success) {
    throw failed("TEXT.MODEL_SCHEMA");
  }
  return decodeAnchored(input, text, parsed.data);
}

function decodeCandidateV1(input: TextInput, text: string, json: unknown): CandidateV1 {
  const parsed = TextCandidateV1Schema.safeParse(json);
  if (!parsed.success) {
    throw failed("TEXT.MODEL_SCHEMA");
  }
  try {
    assertTextQuotes(parsed.data, input, text);
  } catch {
    throw failed("TEXT.CITATION_INVALID");
  }
  return parsed.data;
}

function decodeAnchored(input: TextInput, text: string, wire: AnchoredExtraction): CandidateV2 {
  const lines = evidenceLines(input, text);
  const covered: Quote[] = [];
  const resolve = (anchor: Anchor) => {
    const quote = resolveAnchor(anchor, { lines, text });
    covered.push(quote);
    return quote;
  };
  const optional = (anchor: Anchor | null) => (anchor ? resolve(anchor) : null);
  const formula = wire.formula && {
    servingSize: optional(wire.formula.servingSize),
    nutrients: wire.formula.nutrients.map((nutrient) => ({
      name: resolve(nutrient.name),
      amount: optional(nutrient.amount),
      dailyValue: optional(nutrient.dailyValue),
    })),
  };
  const items: AnchoredItem[] = (wire.ingredients?.items ?? []).map((item) => ({
    ...resolve(item.quote),
    role: item.role,
    parentNutrientIndex: item.parentNutrientIndex,
  }));
  const ingredients = wire.ingredients ? { items } : null;
  const candidate = TextCandidateV2Schema.safeParse({ schemaVersion: 2, formula, ingredients });
  if (!candidate.success) {
    throw failed("TEXT.ROLE_INVALID");
  }
  assertIngredientRoles(items, { input, text, nutrients: formula?.nutrients ?? [] });
  assertIngredientBoundaries(items, text);
  if (wire.issues.length) {
    throw failed("TEXT.INPUT_INCOMPLETE");
  }
  assertExclusions(wire, { input, text, resolve });
  if (!coversEveryPrintedCharacter(text, input.range, covered)) {
    throw failed("TEXT.EXTRACTION_INCOMPLETE");
  }
  assertTextQuotes(candidate.data, input, text);
  return candidate.data;
}

function assertExclusions(
  wire: AnchoredExtraction,
  context: { input: TextInput; text: string; resolve: (anchor: Anchor) => Quote },
): void {
  const source = context.text.slice(context.input.range.start, context.input.range.end);
  for (const exclusion of wire.excluded) {
    const quote = context.resolve(exclusion.quote);
    if (!isAllowedAnchoredExclusion(exclusion.reason, quote, source)) {
      throw failed("TEXT.COVERAGE_UNCERTAIN");
    }
  }
}
