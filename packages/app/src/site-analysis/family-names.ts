/**
 * Owner 2026-11-04 (KAN-253): the family check and the site analysis each name a sub-brand ("Pearls" / "Pearls
 * Probiotics"). One name wins: an exact match after normalizing, else the one name whose words begin or contain the
 * other's. Ambiguous or no match keeps the caller's own name. This compares our two lists, never product pages.
 */
export function familyName(name: string, family: readonly string[]): string | null {
  const wanted = words(name);
  if (!wanted.length) {
    return null;
  }
  const exact = family.filter((candidate) => same(words(candidate), wanted));
  if (exact.length) {
    return exact.length === 1 ? (exact[0] ?? null) : null;
  }
  const close = family.filter((candidate) => {
    const other = words(candidate);
    return other.length > 0 && (contains(other, wanted) || contains(wanted, other));
  });
  return close.length === 1 ? (close[0] ?? null) : null;
}

function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function same(left: string[], right: string[]) {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/** Whole words in order: "pearls" in "pearls probiotics", never "pearl" in "pearls". */
function contains(longer: string[], shorter: string[]) {
  for (let start = 0; start + shorter.length <= longer.length; start++) {
    if (shorter.every((word, index) => longer[start + index] === word)) {
      return true;
    }
  }
  return false;
}
