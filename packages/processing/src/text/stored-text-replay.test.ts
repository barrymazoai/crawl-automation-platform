import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeLabelText } from "./protocol/label-decoder.js";

/**
 * Owner rule (simulate old vs new on stored answers before changing a label rule): every stored text answer in
 * LABEL_TEXT_REPLAY_CASES (one JSON file per answer: range, page text, raw response, policy version; kept out of git)
 * decoded by today's rules. Writes one JSON line per answer (status, codes, formula rows, ingredients) to
 * LABEL_TEXT_REPLAY_OUT, to diff against the same run on the previous commit.
 */
const dir = process.env["LABEL_TEXT_REPLAY_CASES"];

/** An amazon.in answer is read with India's label formats, as its task now names them (KAN-243 step 1). */
const INDIA = ["us-facts/1", "in-nutritional-information/2", "in-composition/2"] as const;

interface ReplayCase {
  id: string;
  observationId?: string;
  range: { start: number; end: number };
  text: string;
  response: string;
  policyVersion?: string;
}

function replayLine(file: string) {
  const replay = JSON.parse(readFileSync(join(dir ?? "", file), "utf8")) as ReplayCase;
  try {
    const decoded = decodeLabelText({
      scope: { range: replay.range },
      text: replay.text,
      response: replay.response,
      ...(replay.policyVersion ? { policyVersion: replay.policyVersion } : {}),
      ...(replay.observationId?.startsWith("amazon-in-") ? { formats: INDIA } : {}),
    });
    const rows = decoded.candidate.formula?.columns.flatMap((column) =>
      column.rows.map((row) => [row.name.text, row.amount?.text ?? null]),
    );
    const other = decoded.candidate.otherIngredients?.items.map((item) => item.text) ?? null;
    return { id: replay.id, status: decoded.status, codes: decoded.codes, rows, other };
  } catch (error) {
    return { id: replay.id, error: String((error as Error).message).slice(0, 120) };
  }
}

describe.skipIf(!dir)("stored text answers decoded with today's rules", () => {
  it("decodes every stored answer", () => {
    const files = readdirSync(dir ?? "")
      .filter((file) => file.endsWith(".json"))
      .sort();
    const lines = files.map((file) => JSON.stringify(replayLine(file)));
    writeFileSync(process.env["LABEL_TEXT_REPLAY_OUT"] ?? "/dev/null", `${lines.join("\n")}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
