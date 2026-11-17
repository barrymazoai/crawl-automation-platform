/**
 * Rewrites a mainIngredients taxonomy hint to the substance names Supply Smart
 * still has (KAN-285).
 *
 * Supply Smart matches a `substance` / `form` hint by exact name and creates a
 * new group when the name is unknown. Since the 2026-11-17 substance cleanup,
 * 238 substance names no longer exist there: sending one recreates the
 * duplicate. This maps them to the keeper before export. Bare names without a
 * hint are left alone: they never create substances.
 *
 * Contract and data: supply-smart-mono
 * docs/packages/database-api/domains/substance-aliases.{md,json}.
 */

import { SUBSTANCE_ALIASES, SUBSTANCE_LABEL_RULES } from "./substance-aliases.data.mjs";

/** Substance key: case and spacing aside (Supply Smart names differ only that way). */
function substanceKey(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Label key: case and punctuation aside ("Magnesium Stearate." = "magnesium stearate"). */
function labelKey(value) {
  return String(value ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const BY_SUBSTANCE = new Map(SUBSTANCE_ALIASES.map((entry) => [substanceKey(entry.alias), entry]));
const BY_LABEL = new Map(SUBSTANCE_LABEL_RULES.map((rule) => [labelKey(rule.label), rule]));

/**
 * @param {{ name?: string, substance?: string, form?: string }} hint
 * @returns {{ substance: string, form: string, rewrite: null | { kind: string, from: string } }}
 *   `substance` / `form` as they should be sent ("" when absent); `rewrite` says what changed.
 */
export function resolveSubstanceHint({ name = "", substance = "", form = "" } = {}) {
  if (!substance) return { substance, form, rewrite: null };

  const rule = BY_LABEL.get(labelKey(name));
  if (rule && substanceKey(rule.substance) !== substanceKey(substance)) {
    // The label belongs to another substance; a form given for the wrong one does not apply.
    return { substance: rule.substance, form: "", rewrite: { kind: "label", from: substance } };
  }

  const alias = BY_SUBSTANCE.get(substanceKey(substance));
  if (!alias) return { substance, form, rewrite: null };
  const next = alias.kind === "form"
    // The old substance is now one form of the keeper; its own forms were folded into it.
    ? { substance: alias.substance, form: alias.form }
    : { substance: alias.substance, form };
  if (next.substance === substance && next.form === form) return { substance, form, rewrite: null };
  return { ...next, rewrite: { kind: alias.kind, from: substance } };
}
