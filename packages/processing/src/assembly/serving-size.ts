import { servingSizeKey as servingKey } from "@crawl-automation/v3-contracts";

/**
 * A shorter wording that the longer one starts with adds no conflict ("1 Level Scoop" / "1 level scoop (5 g)"); a
 * different count or amount still differs. Format-only differences are one value (servingSizeKey).
 */
export function sameServingSize(one: string, other: string): boolean {
  const [shorter, longer] = [servingKey(one), servingKey(other)].sort(
    (left, right) => left.length - right.length,
  );
  if (shorter === undefined || longer === undefined) {
    return false;
  }
  return shorter === longer || (/[a-z]/u.test(shorter) && longer.startsWith(`${shorter} `));
}

/** A bare number ("1") names no unit, so it is no serving size (GNC's attribute table). */
export const UNITLESS = /^\s*\d+(?:[.,]\d+)?\s*$/u;
