type Field = { text: string } | null;
interface Row {
  name: { text: string };
  amount: Field;
}
interface Formula {
  servingSize: Field;
  columns: readonly { rows: readonly Row[] }[];
}

/**
 * Owner 2026-11-07 (KAN-243, amazon.in rerun): two readings of one Indian label agree when each ingredient one prints
 * is an ingredient of the other with the same amount, its name only shorter or longer ("Methylcobalamin IP 1500 mcg"
 * on the front, "Vitamin B12 (Methylcobalamin IP) 1500 mcg" on the back), and the serving names the same unit ("film
 * coated tablet", "1 tablet"). Any other amount, or an ingredient the other reading does not print, still disagrees.
 */
export function sameIngredientsFormula(partial: Formula, complete: Formula): boolean {
  if (!sameServing(partial.servingSize, complete.servingSize)) {
    return false;
  }
  const dosed = (formula: Formula) =>
    formula.columns.flatMap((column) => column.rows).filter((row) => row.amount);
  const rows = dosed(partial);
  const full = dosed(complete);
  // One to one: each ingredient matches exactly one of the other reading's, and no two match the same one.
  const matched = rows.map((row) => full.filter((each) => sameIngredient(row, each)));
  return (
    rows.length > 0 &&
    matched.every((each) => each.length === 1) &&
    new Set(matched.map((each) => each[0])).size === rows.length
  );
}

const amount = (row: Row) => row.amount?.text.toLowerCase().replace(/\s+/gu, "") ?? null;
const NAME_WORD = /[a-z0-9]+/gu;
const words = (row: Row) =>
  new Set((row.name.text.toLowerCase().match(NAME_WORD) ?? []).filter((word) => word.length >= 2));

function sameIngredient(left: Row, right: Row): boolean {
  if (!amount(left) || amount(left) !== amount(right)) {
    return false;
  }
  const first = words(left);
  const second = words(right);
  const [fewer, more] = first.size <= second.size ? [first, second] : [second, first];
  return [...fewer].some((word) => word.length >= 5) && [...fewer].every((word) => more.has(word));
}

const UNIT = /(tablet|capsule|softgel|gumm(?:y|ie)|sachet|scoop|caplet|lozenge)s?\b/u;

/** The same serving, or the same unit with no count other than one ("film coated tablet", "1 tablet"). */
function sameServing(left: Field, right: Field): boolean {
  if (!left || !right) {
    return true;
  }
  const one = left.text.toLowerCase().trim();
  const other = right.text.toLowerCase().trim();
  if (one === other) {
    return true;
  }
  const unit = (text: string) => UNIT.exec(text)?.[1]?.replace(/ie$/u, "y") ?? null;
  const count = (text: string) => Number(/^(\d+)\b/u.exec(text)?.[1] ?? "1");
  return !!unit(one) && unit(one) === unit(other) && count(one) === count(other);
}
