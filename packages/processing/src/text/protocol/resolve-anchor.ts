import { textFailure } from "../errors.js";
import type { EvidenceLine, Quote, Span } from "./evidence-lines.js";
import {
  enclosingPatterns,
  isWholeListEntry,
  isWholeWords,
  occurrences,
  overlaps,
  quotePattern,
} from "./quote-occurrences.js";

/** A quote as the model gives it: inclusive line ids of the selection and the quoted words. */
export interface Anchor {
  fromLine: number;
  toLine: number;
  text: string;
}

/**
 * What the caller knows about where a quote may sit, used only when its words occur more than once in the cited
 * lines (2026-09-29: 85% of label TEXT.CITATION_INVALID Reviews were correct quotes of words repeated on one long
 * line, e.g. "Chicken" in "Chicken Meal, Chicken, Chicken Fat"). A quote found exactly once behaves as before.
 */
export interface AnchorContext {
  /** Printed order: occurrences starting before this offset belong to earlier rows or items. */
  after?: number;
  /** Spans other quotes already hold; the same printed words are never quoted twice. */
  taken?: readonly Span[];
  /** An ingredient-list item: the occurrence must be a whole list entry, not part of a longer one. */
  listItem?: boolean;
  /** A formula row's own amount, which the printed row name may enclose ("Includes 5 g Added Sugars"). */
  enclosed?: string;
}

interface Cited {
  first: EvidenceLine;
  last: EvidenceLine;
  words: string[];
}

const MAX_CITED_LINES = 50;
const citationInvalid = () => textFailure("TEXT.CITATION_INVALID", "executed");

/** Only whitespace can differ from the printed text; the stored quote is the exact original substring. */
/** The numbered lines and full text a quote is placed in. */
export interface QuoteSource {
  lines: readonly EvidenceLine[];
  text: string;
}

export function resolveAnchor(anchor: Anchor, source: QuoteSource, context?: AnchorContext): Quote {
  const { text } = source;
  const cited = citedLines(anchor, source.lines);
  const found = findOccurrences(cited, text, context?.enclosed);
  // The declared span must be tight; a broad window cannot conceal a wrong line id.
  const tight = (span: Span) => span.start <= cited.first.end && span.end > cited.last.start;
  const [only] = found;
  if (found.length === 1 && only) {
    if (!tight(only)) {
      throw citationInvalid();
    }
    return located(text, only);
  }
  if (!found.length || !context) {
    throw citationInvalid();
  }
  const chosen = found.find((span) => tight(span) && fitsContext(text, span, context));
  if (!chosen) {
    throw citationInvalid();
  }
  return located(text, chosen);
}

function citedLines(anchor: Anchor, lines: readonly EvidenceLine[]): Cited {
  const first = lines[anchor.fromLine - 1];
  const last = lines[anchor.toLine - 1];
  const words = anchor.text.trim().split(/\s+/u);
  const tooLong = anchor.toLine - anchor.fromLine > MAX_CITED_LINES;
  if (!first || !last || anchor.toLine < anchor.fromLine || tooLong || !words[0]) {
    throw citationInvalid();
  }
  return { first, last, words };
}

/** The quoted words; only when they are not on the lines, the name with the row's own amount inside it. */
function findOccurrences(cited: Cited, text: string, enclosed?: string): Span[] {
  const window = text.slice(cited.first.start, cited.last.end);
  const find = (pattern: string) => occurrences(window, cited.first.start, pattern);
  const found = find(quotePattern(cited.words));
  if (found.length || !enclosed) {
    return found;
  }
  return enclosingPatterns(cited.words, enclosed).flatMap(find);
}

/** Among repeats: whole words (a whole entry for list items), after the previous item, not already quoted. */
function fitsContext(text: string, span: Span, context: AnchorContext): boolean {
  if (!isWholeWords(text, span)) {
    return false;
  }
  if (context.listItem && !isWholeListEntry(text, span)) {
    return false;
  }
  if (span.start < (context.after ?? 0)) {
    return false;
  }
  return !(context.taken ?? []).some((taken) => overlaps(taken, span));
}

function located(text: string, span: Span): Quote {
  return { text: text.slice(span.start, span.end), start: span.start, end: span.end };
}
