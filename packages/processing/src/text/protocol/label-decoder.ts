import { labelValidationErrors } from "../../label/validation-errors.js";
import {
  LabelTextCandidateSchema,
  LabelAnchorSchema,
  legacyLabelExtractionSchema,
  LabelTextWireSchema,
  assessLabelCandidate,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import type { z } from "zod";
import { drugStructureCodes } from "./drug-label.js";
import { coversEveryPrintedCharacter } from "./coverage.js";
import { evidenceLines, type Quote } from "./evidence-lines.js";
import { exclusionCodes } from "./label-exclusions.js";
import { equivalentFootnoteAllowed, labelCoverage } from "./label-coverage.js";
import { ingredientCodes, rowOrderCodes } from "./label-structure.js";
import { textAssessmentCodes } from "./label-assessment.js";
import { labelLimitErrors } from "./label-limits.js";
import { resolveAnchor, type Anchor, type AnchorContext } from "./resolve-anchor.js";
import { isWithinText, splitsCharacter } from "./text-range.js";
import { textLimits } from "../limits.js";
import { separateTextIngredientDeclarations } from "./ingredient-declarations.js";
import { normalizeUndosedIngredientParagraph } from "./undosed-ingredient-normalization.js";

type Wire = z.infer<typeof LabelTextWireSchema>;
type WireRow = NonNullable<Wire["formula"]>["columns"][number]["rows"][number];
type Candidate = z.infer<typeof LabelTextCandidateSchema>;

export interface DecodedLabel {
  candidate: Candidate;
  status: ReturnType<typeof assessLabelCandidate>["status"] | "review";
  /** Label check codes (`LABEL.*`); empty when the answer is a candidate. */
  codes: string[];
  /** Cited dose-related notes retained without changing a row amount. */
  warnings: { code: string; detail: string }[];
}

/** A label answer to read: the task's range, the full text, the raw answer and the policy it was asked under. */
export interface LabelTextRequest {
  scope: Pick<TextInput, "range">;
  text: string;
  response: string;
  policyVersion?: string;
}

/** Reads a label-extraction/1 answer: places every quote in the text, then runs the label checks. */
export function decodeLabelText(request: LabelTextRequest): DecodedLabel {
  const { scope, text, response, policyVersion = "label-text/2" } = request;
  assertLimits(scope, text, response);
  const schema =
    policyVersion === "label-text/5" || policyVersion === "label-text/6"
      ? LabelTextWireSchema
      : legacyLabelExtractionSchema(LabelAnchorSchema);
  const wire: Wire = schema.parse(JSON.parse(response));
  const quotes = new QuotePlacer(evidenceLines(scope, text), text);
  const candidate = LabelTextCandidateSchema.parse(quotes.place(wire));
  const modelExclusions = candidate.exclusions.length;
  const ingredientHeading = normalizeUndosedIngredientParagraph(candidate, text, scope.range);
  separateTextIngredientDeclarations(candidate);
  return validateCandidate({
    candidate,
    text,
    range: scope.range,
    policyVersion,
    modelExclusions,
    placed: ingredientHeading ? [...quotes.placed, ingredientHeading] : quotes.placed,
  });
}

function validateCandidate(input: {
  candidate: Candidate;
  text: string;
  range: TextInput["range"];
  policyVersion: string;
  modelExclusions: number;
  placed: readonly Quote[];
}): DecodedLabel {
  const { candidate, text, range, policyVersion, modelExclusions, placed } = input;
  const assessment = assessLabelCandidate(candidate);
  const structureCodes = ingredientCodes(candidate, text);
  const codes = new Set([
    ...textAssessmentCodes(candidate, assessment.codes),
    ...rowOrderCodes(candidate),
    ...drugStructureCodes(candidate, text, range),
    ...structureCodes,
    // Model exclusions still need policy review; decoded slices already have exact placed citations.
    ...exclusionCodes({
      candidate: { ...candidate, exclusions: candidate.exclusions.slice(0, modelExclusions) },
      text,
      policyVersion,
    }),
  ]);
  const coverage = labelCoverage(candidate, { text, range }, placed);
  if (!coversEveryPrintedCharacter(text, range, coverage)) {
    codes.add(labelValidationErrors.code("LABEL.EXTRACTION_INCOMPLETE"));
  }
  const warnings = candidateWarnings(candidate, text, assessment.warnings);
  const status = candidateStatus({ candidate, assessment, codes });
  return { candidate, status, codes: [...codes], warnings };
}

function candidateWarnings(
  candidate: Candidate,
  text: string,
  warnings: DecodedLabel["warnings"],
): DecodedLabel["warnings"] {
  const equivalent = candidate.exclusions
    .filter((exclusion) => equivalentFootnoteAllowed(exclusion, candidate, text))
    .map((exclusion) => ({ code: "equivalent-footnote", detail: exclusion.quote.text }));
  return [...warnings, ...equivalent];
}

function candidateStatus(input: {
  candidate: Candidate;
  assessment: ReturnType<typeof assessLabelCandidate>;
  codes: Set<string>;
}): DecodedLabel["status"] {
  const { candidate, assessment, codes } = input;
  if (codes.size) {
    return "review";
  }
  if (assessment.status === "review") {
    return candidate.formula ? "candidate" : "partial";
  }
  return assessment.status;
}

function assertLimits(scope: Pick<TextInput, "range">, text: string, response: string): void {
  const tooLarge =
    Buffer.byteLength(response) > textLimits.responseBytes ||
    text.length > textLimits.sourceTextLength;
  if (tooLarge || !isWithinText(scope.range, text.length)) {
    throw labelLimitErrors.create("LABEL.TEXT_LIMIT");
  }
  if (splitsCharacter(text, scope.range)) {
    throw labelLimitErrors.create("LABEL.TEXT_RANGE");
  }
}

/**
 * Places each quote of the answer in the text. Repeated words are placed by printed order and by what earlier quotes
 * already hold (see AnchorContext): rows in order within a column, a row's amount and DV after its name, ingredient
 * items in list order after their heading.
 */
class QuotePlacer {
  readonly placed: Quote[] = [];

  constructor(
    private readonly lines: ReturnType<typeof evidenceLines>,
    private readonly text: string,
  ) {}

  place(wire: Wire) {
    const formula = wire.formula && {
      ...(wire.formula.drugFacts ? { drugFacts: this.field(wire.formula.drugFacts) } : {}),
      servingSize: this.optional(wire.formula.servingSize),
      servingsPerContainer: this.optional(wire.formula.servingsPerContainer),
      columns: wire.formula.columns.map((column) => ({
        heading: this.optional(column.heading),
        rows: this.rows(column.rows),
      })),
    };
    const otherIngredients = wire.otherIngredients && this.ingredients(wire.otherIngredients);
    const exclusions = wire.exclusions.map((exclusion) => ({
      ...exclusion,
      quote: this.field(exclusion.quote),
    }));
    return { ...wire, formula, otherIngredients, exclusions };
  }

  private field(anchor: Anchor, context: AnchorContext = {}): Quote {
    const quote = resolveAnchor(
      anchor,
      { lines: this.lines, text: this.text },
      { taken: this.placed, ...context },
    );
    this.placed.push(quote);
    return quote;
  }

  private optional(anchor: Anchor | null, context?: AnchorContext): Quote | null {
    return anchor ? this.field(anchor, context) : null;
  }

  private rows(rows: readonly WireRow[]) {
    let after = 0;
    return rows.map((row) => {
      const enclosed = row.amount ? { enclosed: row.amount.text } : {};
      const rowStart = after;
      const name = this.field(row.name, { after, ...enclosed });
      after = name.end;
      // The row's own amount and DV sit after the previous row, on either side of the name: a Nutrition Facts panel
      // prints "including 0 g Added Sugars" (bloodsugarfriendly.com 2026-10-21), and a name may enclose the amount.
      const own = { after: rowStart, taken: this.placed.filter((quote) => quote !== name) };
      const amount = this.optional(row.amount, own);
      const afterAmount = amount?.end ?? name.start;
      return {
        ...row,
        name,
        amount,
        dailyValue: this.optional(row.dailyValue, { ...own, after: afterAmount }),
        ...(row.purpose ? { purpose: this.optional(row.purpose, own) } : {}),
      };
    });
  }

  private ingredients(other: NonNullable<Wire["otherIngredients"]>) {
    const heading = this.field(other.heading);
    let after = heading.end;
    const items = other.items.map((item) => {
      const quote = this.field(item, { after, listItem: true });
      after = quote.end;
      return quote;
    });
    return { heading, items };
  }
}
