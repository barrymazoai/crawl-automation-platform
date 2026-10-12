import { servingSizeKey } from "../packaging.js";
import type { LabelEquivalence } from "./rule.js";

export const servingSizeEquivalences: readonly LabelEquivalence[] = [
  {
    id: "serving-size-format-only",
    added: "2026-10-09",
    why:
      "Owner 2026-10-08/09: sizes that differ only in format are one value: spacing, case, \"(s)\", singular/plural " +
      "unit words, a spelled-out count, \"2.0\" for \"2\" (\"1 Capsule\" / \"1 Capsule(s)\" on GNC).",
    same: (one, other) => servingSizeKey(one) === servingSizeKey(other),
  },
  {
    id: "serving-size-shorter-wording",
    added: "2026-10-08",
    why:
      "A shorter wording that the longer one starts with adds no conflict (\"1 Level Scoop\" / \"1 level scoop (5 g)\"); " +
      "a bare number names no unit, so it never matches this way.",
    same(one, other) {
      const [shorter, longer] = [servingSizeKey(one), servingSizeKey(other)].sort((a, b) => a.length - b.length);
      return /[a-z]/u.test(shorter!) && longer!.startsWith(`${shorter} `);
    },
  },
];

/** Assembly and the collected record's recheck both use this one comparison (2026-10-12). */
export function sameServingSize(one: string, other: string): boolean {
  return servingSizeEquivalences.some((rule) => rule.same(one, other));
}
