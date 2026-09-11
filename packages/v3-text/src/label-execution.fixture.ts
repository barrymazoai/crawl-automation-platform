import { LabelTextWireSchema, TextInputSchema, textFingerprint } from "@crawl-automation/v3-contracts";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { fixture } from "./testing.fixture.js";
import { CodexTextProvider } from "./codex-provider.js";
import { hashText } from "./handoff.js";
export const labelConfig = { settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
  executable: "/bin/codex", codexHome: "/private/test-auth", workRoot: "/private/test-work", timeoutMs: 240000, runtimeProfileVersion: "gnc-live/1" };
/** Synthetic exact-text source and anchored answer; never a real model quality claim. */
export function labelExecutionFixture() {
  const c = gncLabelFixture(), lines: string[] = [];
  const field = (f: { text: string }) => { lines.push(f.text); return { text: f.text, fromLine: lines.length, toLine: lines.length }; };
  const optional = (f: { text: string } | null) => f ? field(f) : null;
  const formula = c.formula!;
  const wire = LabelTextWireSchema.parse({ ...c,
    formula: { servingSize: optional(formula.servingSize), servingsPerContainer: optional(formula.servingsPerContainer),
      columns: formula.columns.map(col => ({ heading: optional(col.heading), rows: col.rows.map(row => ({ ...row,
        name: field(row.name), amount: optional(row.amount), dailyValue: optional(row.dailyValue) })) })) },
    otherIngredients: { heading: field(c.otherIngredients!.heading), items: c.otherIngredients!.items.map((f, i) => { if (i) lines.push(","); return field(f); }) },
  });
  const f = fixture(lines.join("\n")), supported = CodexTextProvider.describe({ ...labelConfig, extractionProtocol: "label-extraction/1" });
  const unsigned = { ...f.input, ...supported };
  const input = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, hashText) });
  return { ...f, input, wire, supported };
}
