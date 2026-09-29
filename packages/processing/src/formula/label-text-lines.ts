/** Text compared as a label reads: case, spacing, dashes and unicode forms ignored. */
export function normalizeLabel(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―]/gu, "-")
    .replace(/µ/gu, "mc")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The label's lines, normalized, empty lines dropped. */
export function labelLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map(normalizeLabel)
    .filter((line) => line.length > 0);
}

/** An amount with a unit: what makes a line a formula row. */
const AMOUNT = /\d(?:[\d.,]*)\s*(?:mg|mcg|g|iu|kcal|cal|cfu|billion|%)(?![a-z])/u;
/** Header lines carry amounts too but are not formula rows. */
const HEADER = /serving size|servings per|amount per serving|daily value|calories from fat/u;

/** The lines that state an ingredient amount, before the other-ingredients section. */
export function amountLines(lines: readonly string[]): string[] {
  const end = lines.findIndex((line) => line.startsWith("other ingredient"));
  const facts = end === -1 ? lines : lines.slice(0, end);
  return facts.filter((line) => AMOUNT.test(line) && !HEADER.test(line));
}

/** Splits a list at commas and semicolons that are not inside parentheses or brackets. */
function splitTopLevel(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of list) {
    depth += "([".includes(character) ? 1 : ")]".includes(character) ? -1 : 0;
    if (depth === 0 && ",;".includes(character)) {
      items.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  return [...items, current];
}

/** A line that starts the next section, e.g. "suggested use:" or "warning:". */
const NEXT_SECTION = /^[a-z][a-z /&-]{2,40}:/u;

/**
 * The other-ingredients list the label prints, normalized: [] when it prints "None", null when it prints no
 * other-ingredients section at all. The list ends at the next section heading.
 */
export function otherIngredientItems(lines: readonly string[]): string[] | null {
  const start = lines.findIndex((line) => line.startsWith("other ingredient"));
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => NEXT_SECTION.test(line));
  const section = [lines[start] ?? "", ...(end === -1 ? rest : rest.slice(0, end))].join(" ");
  const list = section.replace(/^other ingredients?\s*:?\s*/u, "");
  const items = splitTopLevel(list)
    .map((item) => normalizeLabel(item).replace(/^and /u, "").replace(/\.$/u, ""))
    .filter((item) => item.length > 0);
  return items.length === 1 && items[0] === "none" ? [] : items;
}
