/** " and " outside parentheses/brackets: the only places a printed list joins its last two items. */
function topLevelAnds(text: string): number[] {
  const at: number[] = [];
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const ch = text.charAt(index);
    depth = Math.max(0, depth + ("([{".includes(ch) ? 1 : 0) - (")]}".includes(ch) ? 1 : 0));
    if (depth === 0 && /^ and /i.test(text.slice(index, index + 5))) {
      at.push(index);
    }
  }
  return at;
}

/** A name that shares its last words with the one before ("Natural and Artificial Flavors", "Mono- and Diglycerides"). */
const SHARED_NOUN = /\bflavou?rs?\b|\bcolou?rs?\b|-$/i;
/** A printed ingredient name: starts with a capital (or a digit/letter prefix like "D-Biotin") and has a word. */
const NAME = /^[A-Z0-9][^\s]*[A-Za-z]/;

/**
 * Owner 2026-11-06 (NOW Glutathione on amazon.in: "…, Magnesium Stearate (vegetable source) and Silicon Dioxide."):
 * the last item of a comma list joining two names with "and" is two items. Only when exactly one top-level "and"
 * joins two capitalised names of two words or more on the left; a shared noun ("Natural and Artificial Flavors",
 * "Mono- and Diglycerides") and lower-case lists ("double-distilled and deionized water") stay as printed. The list's
 * closing full stop goes with the split.
 */
export function splitFinalAnd(items: readonly string[]): string[] {
  const last = items.at(-1);
  if (items.length < 2 || !last) {
    return [...items];
  }
  const text = last.replace(/\.\s*$/, "");
  const ands = topLevelAnds(text);
  const at = ands[0];
  if (ands.length !== 1 || at === undefined) {
    return [...items];
  }
  const left = text.slice(0, at).trim();
  const right = text.slice(at + 5).trim();
  const named = NAME.test(left) && NAME.test(right) && left.split(/\s+/).length >= 2;
  if (!named || SHARED_NOUN.test(left) || SHARED_NOUN.test(right)) {
    return [...items];
  }
  return [...items.slice(0, -1), left, right];
}
