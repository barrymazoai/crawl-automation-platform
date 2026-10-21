import type { LabelRule } from "./rule.js";

const declaration =
  /\b(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|shared\s+equipment)/giu;

/** The keyword's position decides its role; nested parentheses and square brackets are ingredient descriptions. */
export function outsideBrackets(text: string, index: number): boolean {
  let depth = 0;
  for (let at = 0; at < index; at++) {
    if (text[at] === "(" || text[at] === "[") depth++;
    if (text[at] === ")" || text[at] === "]") depth--;
  }
  return depth === 0;
}

/** B0GJHXSVDM prints "colors (may contain black carrot...)" as an ingredient source description. */
export const bracketedMayContainIsNotADeclarationRule: LabelRule<string> = {
  id: "bracketed-may-contain-is-not-a-declaration",
  code: "LABEL.INGREDIENT_ROLE_INVALID",
  added: "2026-10-21",
  why: "B0GJHXSVDM colors (may contain black carrot...) and B001VNEHA4 Paprika (may contain Silicon Dioxide) are ingredient descriptions; top-level allergen statements still belong outside the ingredient list.",
  check(text) {
    for (const match of text.matchAll(declaration)) {
      if (outsideBrackets(text, match.index)) {
        return "an ingredient item contains a top-level allergen/manufacturing statement";
      }
    }
    return null;
  },
};
