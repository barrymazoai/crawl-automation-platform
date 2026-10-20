/** Where a page's label sits in its text: one Facts panel and the ingredient statement that follows it. */
export interface LabelRange {
  start: number;
  end: number;
}

// Drug Facts are laid out differently (actives, uses, warnings, inactive ingredients): those pages stay whole.
const HEADING = /^(supplement|nutrition)\s+facts\b/i;
const DRUG_HEADING = /^drug\s+facts\b/i;
const INGREDIENTS = /^(other\s+)?ingredients\b/i;
const INGREDIENTS_HEADING = /^(other\s+)?ingredients\s*:?$/i;
const TAIL = /^((other\s+)?ingredients\b|contains\b|allergen)/i;
const FOOTNOTE = /(daily value|%\s*dv\b|^\*|^†)/i;
const AMOUNT = /(\d+(?:\.\d+)?)\s*(mcg|mg|ml|g|iu|%)\b/gi;
const HAS_AMOUNT = /\d+(?:\.\d+)?\s*(mcg|mg|ml|g|iu|%)\b/i;
const MAX_PANEL_LINES = 80;
const MAX_TAIL_LINES = 40;
const MAX_TAIL_GAP = 6;
const MAX_FOOTNOTE_GAP = 2;
const SAME_LABEL_SHARE = 0.8;

interface Panel {
  head: number;
  end: number;
  ingredients: boolean;
  /** Its end is known: a Daily Value footnote. Drug Facts or a "Supplement facts - …" sentence have none. */
  footnote: boolean;
}

/**
 * Owner 2026-10-20 (bloodsugarfriendly.com): a product page repeats its Facts panel and surrounds it with marketing
 * text; given the whole page, the label text model had to account for hundreds of lines and failed every time. The
 * text task covers only the panel and the ingredient statement right after it. The whole page stays the input
 * (null) when the page has no panel whose end is known (a Daily Value footnote; not Drug Facts), panels with
 * different amounts (two strengths, a kit), or ingredients the chosen panel does not reach. Simulated on 3,000
 * retained pages: no ingredient statement lost.
 */
export function labelRange(text: string): LabelRange | null {
  const lines = text.split("\n");
  if (lines.some((line) => DRUG_HEADING.test(line.trim()))) {
    return null;
  }
  const found = panels(lines);
  const ended = found.filter((panel) => panel.footnote);
  const [first] = ended;
  if (!first || !sameLabel(lines, found)) {
    return null;
  }
  const best = ended.reduce(
    (chosen, panel) => (panel.ingredients && !chosen.ingredients ? panel : chosen),
    first,
  );
  const start = offset(lines, best.head);
  const end = offset(lines, best.end + 1) - 1;
  const hasIngredients = (part: string[]) => part.some((line) => INGREDIENTS.test(line.trim()));
  if (hasIngredients(lines) && !hasIngredients(text.slice(start, end).split("\n"))) {
    return null;
  }
  return { start, end };
}

function panels(lines: string[]): Panel[] {
  const heads = lines.flatMap((line, index) => (HEADING.test(line.trim()) ? [index] : []));
  return heads.map((head, index) => {
    const stop = Math.min(heads[index + 1] ?? lines.length, head + MAX_PANEL_LINES);
    const end = panelEnd(lines, head, stop);
    return { head, footnote: end > head, ...tail(lines, end) };
  });
}

/** "% Daily Value", "%DV", "Amount Per Serving % Daily Value": the column heading, not a footnote. */
const COLUMN_HEADING = /^(amount\s+per\s+serving\s*)?%\s*(daily\s+value|dv)\*?$/i;
/** A footnote line: Daily Value wording without an amount ("Total Fat 8 g (10% DV)" is a row). */
const isFootnote = (value: string) =>
  FOOTNOTE.test(value) && !HAS_AMOUNT.test(value) && !COLUMN_HEADING.test(value);

/**
 * The panel ends at its footnote block: the first footnote after a row, and the footnote lines right after it. A
 * "% Daily Value" column heading comes before the rows; a later "40% of the Daily Value" sentence is not the panel.
 */
function panelEnd(lines: string[], head: number, stop: number): number {
  let rows = false;
  for (let line = head + 1; line < stop; line++) {
    const value = lines[line]?.trim() ?? "";
    if (rows && isFootnote(value)) {
      return footnoteBlockEnd(lines, line, stop);
    }
    rows ||= HAS_AMOUNT.test(value) && !/^serving/i.test(value);
  }
  return head;
}

function footnoteBlockEnd(lines: string[], first: number, stop: number): number {
  let end = first;
  for (let line = first + 1; line < stop; line++) {
    const value = lines[line]?.trim() ?? "";
    if (!value) {
      continue;
    }
    if (line - end > MAX_FOOTNOTE_GAP || !isFootnote(value)) {
      break;
    }
    end = line;
  }
  return end;
}

/** The ingredient statement and allergen lines right after a panel; a second ingredient list is not taken. */
function tail(lines: string[], panelEnd: number) {
  let end = panelEnd;
  let ingredients = false;
  // An "Other Ingredients" heading on its own line: the list is the next line (Natrol, 2026-10-20).
  let listNext = false;
  const last = Math.min(lines.length, panelEnd + 1 + MAX_TAIL_LINES);
  for (let line = panelEnd + 1; line < last; line++) {
    const value = lines[line]?.trim() ?? "";
    if (listNext && value) {
      end = line;
      listNext = false;
      continue;
    }
    const step = tailStep(value, { gap: line - end, ingredients });
    if (step === "stop") {
      break;
    }
    if (step !== "skip") {
      end = line;
      ingredients ||= step === "ingredients";
      listNext = step === "ingredients" && INGREDIENTS_HEADING.test(value);
    }
  }
  return { end, ingredients };
}

function tailStep(value: string, at: { gap: number; ingredients: boolean }) {
  if (!value) {
    return "skip";
  }
  if (at.gap > MAX_TAIL_GAP || HEADING.test(value)) {
    return "stop";
  }
  if (!TAIL.test(value)) {
    return "skip";
  }
  if (!INGREDIENTS.test(value)) {
    return "allergen";
  }
  return at.ingredients ? "stop" : "ingredients";
}

/** Repeats of one label (a table and its prose summary) share their amounts; different labels do not. */
function sameLabel(lines: string[], found: Panel[]): boolean {
  const sets = found.map((panel) => amounts(lines.slice(panel.head, panel.end + 1).join(" ")));
  const largest = sets.reduce((most, set) => (set.size > most.size ? set : most));
  return sets.every(
    (set) => [...set].filter((value) => largest.has(value)).length >= SAME_LABEL_SHARE * set.size,
  );
}

function amounts(text: string): Set<string> {
  return new Set([...text.matchAll(AMOUNT)].map((match) => `${match[1]}${match[2]}`.toLowerCase()));
}

function offset(lines: string[], line: number): number {
  return lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0);
}
