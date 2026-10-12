/**
 * Label rule table (plan 2026-10-12, part C). Each label validation or equivalence rule is one entry with an ID, the
 * date and reason it was added, and its check. Its real examples live in `examples/` (test-only) and every rule must
 * accept its `pass` examples and reject its `fail` examples, so a new or narrowed rule that breaks an older example
 * fails at once. A new case adds a rule with examples; an over-broad rule is narrowed with the example that exposed it.
 */
export interface LabelRule<Subject> {
  /** Stable kebab-case ID, recorded on every finding the rule raises. */
  id: string;
  /** The finding code the rule raises; existing codes are kept so Reviews and policies keep their meaning. */
  code: string;
  /** Date the rule was added or last narrowed, and why. */
  added: string;
  why: string;
  /** The detail text when the subject breaks the rule, or null when it passes. */
  check(subject: Subject): string | null;
}

/** "These two printed values are the same": a value pair is the same when any equivalence rule says so. */
export interface LabelEquivalence {
  id: string;
  added: string;
  why: string;
  same(one: string, other: string): boolean;
}

/** A real example from a stored label (`source` names the Review or listing); `constructed` only for a contrast. */
export interface LabelRuleExample<Subject> {
  subject: Subject;
  source: string;
}

export interface LabelRuleExamples<Subject> {
  pass: LabelRuleExample<Subject>[];
  fail: LabelRuleExample<Subject>[];
}

export interface LabelEquivalenceExamples {
  same: LabelRuleExample<[string, string]>[];
  different: LabelRuleExample<[string, string]>[];
}

export interface RuleFinding {
  code: string;
  detail: string;
  rule: string;
}

/** Runs rules in table order; each rule reports at most once per subject. */
export function applyLabelRules<Subject>(
  rules: readonly LabelRule<Subject>[],
  subject: Subject,
): RuleFinding[] {
  return rules.flatMap((rule) => {
    const detail = rule.check(subject);
    return detail === null ? [] : [{ code: rule.code, detail, rule: rule.id }];
  });
}
