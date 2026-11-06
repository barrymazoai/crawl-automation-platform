import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import {
  decodeIngredientPresenceAnswer,
  isIngredientPresenceAnswer,
} from "./protocol/label-ingredient-presence.js";
import { decodeTranscriptAnswer, isTranscriptAnswer } from "./protocol/label-transcript-answer.js";

/**
 * Owner rule (simulate old vs new on stored answers before changing a label rule): every stored vision answer in
 * LABEL_REPLAY_ANSWERS (R2 `v3/vision/<op>/response.json`, kept out of git) decoded by today's rules. Writes one JSON
 * line per answer (status, codes, rows, other ingredients) to LABEL_REPLAY_OUT, to diff against the same run on the
 * previous commit. label-visual-answer/3 and /4 only; older codecs are left out.
 */
const dir = process.env["LABEL_REPLAY_ANSWERS"];

function summary(candidate: LabelImageCandidate) {
  const rows = candidate.formula?.columns.flatMap((column) =>
    column.rows.map((row) => [
      row.kind,
      row.name.text,
      row.amount?.text ?? null,
      row.dailyValue?.text ?? null,
    ]),
  );
  return { rows, other: candidate.otherIngredients?.items.map((item) => item.text) ?? null };
}

function decode(raw: string) {
  if (isTranscriptAnswer(raw)) {
    return { codec: "label-visual-answer/4", ...decodeTranscriptAnswer(raw) };
  }
  if (isIngredientPresenceAnswer(raw)) {
    return { codec: "label-visual-answer/3", ...decodeIngredientPresenceAnswer(raw) };
  }
  return null;
}

describe.skipIf(!dir)("stored vision answers decoded with today's rules", () => {
  it("decodes every stored answer", () => {
    const lines: string[] = [];
    for (const name of readdirSync(dir ?? "")
      .filter((file) => file.endsWith(".json"))
      .sort()) {
      const body = JSON.parse(readFileSync(join(dir ?? "", name), "utf8"));
      const raw = typeof body.raw === "string" ? body.raw : JSON.stringify(body.raw ?? body);
      try {
        const decoded = decode(raw);
        const line = decoded
          ? {
              name,
              codec: decoded.codec,
              status: decoded.status,
              codes: decoded.codes,
              ...summary(decoded.candidate),
            }
          : { name, codec: "other" };
        lines.push(JSON.stringify(line));
      } catch (error) {
        lines.push(JSON.stringify({ name, error: String((error as Error).message).slice(0, 120) }));
      }
    }
    writeFileSync(process.env["LABEL_REPLAY_OUT"] ?? "/dev/null", `${lines.join("\n")}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
