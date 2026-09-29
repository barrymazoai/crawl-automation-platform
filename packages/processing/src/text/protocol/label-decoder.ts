import {
  LabelTextCandidateSchema,
  LabelTextWireSchema,
  assessLabelCandidate,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import type { z } from "zod";
import { coversEveryPrintedCharacter } from "./coverage.js";
import { evidenceLines, type Quote } from "./evidence-lines.js";
import { exclusionCodes } from "./label-exclusions.js";
import { ingredientCodes, rowOrderCodes } from "./label-structure.js";
import { labelLimitErrors } from "./label-limits.js";
import { resolveAnchor, type Anchor, type AnchorContext } from "./resolve-anchor.js";
import { isWithinText, splitsCharacter } from "./text-range.js";
import { textLimits } from "../limits.js";

type Wire = z.infer<typeof LabelTextWireSchema>;
type WireRow = NonNullable<Wire["formula"]>["columns"][number]["rows"][number];
type Candidate = z.infer<typeof LabelTextCandidateSchema>;

export interface DecodedLabel {
  candidate: Candidate;
  status: ReturnType<typeof assessLabelCandidate>["status"] | "review";
  /** Label check codes (`LABEL.*`); empty when the answer is a candidate. */
  codes: string[];
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
  const wire = LabelTextWireSchema.parse(JSON.parse(response));
  const quotes = new QuotePlacer(evidenceLines(scope, text), text);
  const candidate = LabelTextCandidateSchema.parse(quotes.place(wire));
  const assessment = assessLabelCandidate(candidate);
  const codes = new Set([
    ...assessment.codes,
    ...rowOrderCodes(candidate),
    ...ingredientCodes(candidate, text),
    ...exclusionCodes({ candidate, text, policyVersion }),
  ]);
  if (!coversEveryPrintedCharacter(text, scope.range, quotes.placed)) {
    codes.add("LABEL.EXTRACTION_INCOMPLETE");
  }
  return { candidate, status: codes.size ? "review" : assessment.status, codes: [...codes] };
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
      const name = this.field(row.name, { after, ...enclosed });
      after = name.end;
      // The row's own amount and DV follow its name, and may sit inside a name that encloses the amount.
      const own = { after: name.start, taken: this.placed.filter((quote) => quote !== name) };
      return {
        ...row,
        name,
        amount: this.optional(row.amount, own),
        dailyValue: this.optional(row.dailyValue, own),
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
