/** Where a page's label sits in its text: one Facts panel and the ingredient statement that follows it. */
export interface LabelRange {
  start: number;
  end: number;
}

const HEADING = /^(supplement|nutrition|drug)\s+facts\b/i;
const INGREDIENTS = /^(other\s+)?ingredients\b/i;
const TAIL = /^((other\s+)?ingredients\b|contains\b|allergen)/i;
const FOOTNOTE = /(daily value|%\s*dv\b|^\*|^†)/i;
const AMOUNT = /(\d+(?:\.\d+)?)\s*(mcg|mg|g|iu|%)\b/gi;
const MAX_PANEL_LINES = 80;
const MAX_TAIL_LINES = 40;
const MAX_TAIL_GAP = 6;
const SAME_LABEL_SHARE = 0.8;

interface Panel {
  head: number;
  end: number;
  ingredients: boolean;
}

/**
 * Owner 2026-10-20 (bloodsugarfriendly.com): a product page repeats its Facts panel and surrounds it with marketing
 * text; given the whole page, the label text model had to account for hundreds of lines and failed every time. The
 * text task covers only the panel and the ingredient statement right after it. The whole page stays the input
 * (null) when the page has no panel, panels with different amounts (two strengths, a kit), or ingredients the
 * chosen panel does not reach. Simulated on 3,000 retained pages: no ingredient statement lost.
 */
export function labelRange(text: string): LabelRange | null {
  const lines = text.split("\n");
  const found = panels(lines);
  const [first] = found;
  if (!first || !sameLabel(lines, found)) {
    return null;
  }
  const best = found.reduce(
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
    let end = head;
    for (let line = head; line < stop; line++) {
      const value = lines[line]?.trim() ?? "";
      if (value && FOOTNOTE.test(value)) {
        end = line;
      }
    }
    return { head, ...tail(lines, end) };
  });
}

/** The ingredient statement and allergen lines right after a panel; a second ingredient list is not taken. */
function tail(lines: string[], panelEnd: number) {
  let end = panelEnd;
  let ingredients = false;
  const last = Math.min(lines.length, panelEnd + 1 + MAX_TAIL_LINES);
  for (let line = panelEnd + 1; line < last; line++) {
    const value = lines[line]?.trim() ?? "";
    const step = tailStep(value, { gap: line - end, ingredients });
    if (step === "stop") {
      break;
    }
    if (step !== "skip") {
      end = line;
      ingredients ||= step === "ingredients";
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
