import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import {
  decodeIngredientPresenceAnswer,
  isIngredientPresenceAnswer,
} from "./protocol/label-ingredient-presence.js";
import {
  decodeTranscriptAnswer,
  dosedRows,
  isTranscriptAnswer,
  transcriptAnswer,
} from "./protocol/label-transcript-answer.js";
import { copiesPairedRows, transcriptCandidate } from "./protocol/label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./protocol/label-transcript-wire.js";

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
  return {
    rows,
    other: candidate.otherIngredients?.items.map((item) => item.text) ?? null,
    serving: [
      candidate.formula?.servingSize?.text ?? null,
      candidate.formula?.servingsPerContainer?.text ?? null,
    ],
  };
}

const INDIA = ["us-facts/1", "in-nutritional-information/2", "in-composition/2"] as const;

/**
 * A label-protocol answer's copy that was not accepted, as the copy rules read it. The formats are amazon.in's, which
 * read a US panel exactly as the US format does.
 */
function copyRows(raw: string) {
  const attempt = JSON.parse(raw)?.transcriptAttempt;
  if (!attempt) {
    return undefined;
  }
  const policy = { allowNoOtherIngredientsSection: true };
  try {
    const wire = labelTranscriptWireSchema.parse(JSON.parse(attempt.raw));
    const built = copiesPairedRows(wire, INDIA)
      ? { reason: "two ingredients in one row" }
      : transcriptCandidate(wire, policy, INDIA);
    return {
      reason: attempt.reason,
      rows: "reason" in built ? built.reason : summary(built.candidate).rows,
      ...("reason" in built ? {} : copyChecks(attempt.raw, built.candidate)),
    };
  } catch (error) {
    return { reason: attempt.reason, rows: String((error as Error).message).slice(0, 80) };
  }
}

/**
 * The copy's own checks, and its Other Ingredients items, if the OCR or a re-read confirmed every amount (what would
 * still send it back).
 */
function copyChecks(raw: string, candidate: LabelImageCandidate) {
  const ocrConfirmed = dosedRows(candidate).map(({ index }) => index);
  const policy = { allowNoOtherIngredientsSection: true };
  const answer = transcriptAnswer({ policy, raw, ocrConfirmed, reread: null, formats: [...INDIA] });
  const decoded = decodeTranscriptAnswer(answer);
  return { checks: decoded.codes, other: summary(decoded.candidate).other };
}

function decode(raw: string) {
  if (isTranscriptAnswer(raw)) {
    return { codec: "label-visual-answer/4", ...decodeTranscriptAnswer(raw) };
  }
  if (isIngredientPresenceAnswer(raw)) {
    return {
      codec: "label-visual-answer/3",
      ...decodeIngredientPresenceAnswer(raw),
      copy: copyRows(raw),
    };
  }
  return null;
}

function replayLine(name: string, raw: string) {
  try {
    const decoded = decode(raw);
    if (!decoded) {
      return { name, codec: "other" };
    }
    const { codec, status, codes, candidate } = decoded;
    const copy = "copy" in decoded ? decoded.copy : undefined;
    return { name, codec, status, codes, ...summary(candidate), ...(copy ? { copy } : {}) };
  } catch (error) {
    return { name, error: String((error as Error).message).slice(0, 120) };
  }
}

describe.skipIf(!dir)("stored vision answers decoded with today's rules", () => {
  it("decodes every stored answer", () => {
    const lines: string[] = [];
    for (const name of readdirSync(dir ?? "")
      .filter((file) => file.endsWith(".json"))
      .sort()) {
      const body = JSON.parse(readFileSync(join(dir ?? "", name), "utf8"));
      const raw = typeof body.raw === "string" ? body.raw : JSON.stringify(body.raw ?? body);
      lines.push(JSON.stringify(replayLine(name, raw)));
    }
    writeFileSync(process.env["LABEL_REPLAY_OUT"] ?? "/dev/null", `${lines.join("\n")}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
