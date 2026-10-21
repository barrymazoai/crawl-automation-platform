/** Offsets are relative to the original ingredient item, so each decoder can retain its own citation. */
export interface IngredientPart {
  text: string;
  start: number;
  end: number;
}

export interface IngredientTail {
  ingredient: IngredientPart | null;
  allergen: IngredientPart | null;
  noise: IngredientPart | null;
}

const DECLARATION =
  /(?:^|[.;]\s*|\s+\*+\s*|\s+)(?:contains\s*:|may\s+contain\b|manufactured\s+(?:in|on)\b|processed\s+(?:in|on)\b|shared\s+equipment)/gi;
const FRENCH_LABEL = /\bingr[eé]dients?\s*:/gi;

function part(text: string, start: number, end: number): IngredientPart | null {
  while (start < end && /\s/u.test(text.charAt(start))) {
    start++;
  }
  while (end > start && /\s/u.test(text.charAt(end - 1))) {
    end--;
  }
  return start < end ? { text: text.slice(start, end), start, end } : null;
}

function outsideBrackets(text: string, index: number): boolean {
  let depth = 0;
  for (let at = 0; at < index; at++) {
    if (text[at] === "(" || text[at] === "[") {
      depth++;
    }
    if (text[at] === ")" || text[at] === "]") {
      depth--;
    }
  }
  return depth === 0;
}

function firstFrenchLabel(text: string): number | null {
  for (const match of text.matchAll(FRENCH_LABEL)) {
    if (outsideBrackets(text, match.index)) {
      return match.index;
    }
  }
  return null;
}

function firstDeclaration(text: string): number | null {
  for (const match of text.matchAll(DECLARATION)) {
    const keyword = match[0].search(/contains|may\s+contain|manufactured|processed|shared/i);
    const start = match.index + keyword;
    if (outsideBrackets(text, start)) {
      return start;
    }
  }
  return null;
}

/** Split a trailing declaration and a repeated French label section only at top level. */
export function splitIngredientTail(text: string): IngredientTail {
  const french = firstFrenchLabel(text);
  const englishEnd = french ?? text.length;
  const declaration = firstDeclaration(text.slice(0, englishEnd));
  return {
    ingredient: part(text, 0, declaration ?? englishEnd),
    allergen: declaration === null ? null : part(text, declaration, englishEnd),
    noise: french === null ? null : part(text, french, text.length),
  };
}
