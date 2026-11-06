import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKETPLACE_LABEL_FORMATS } from "@crawl-automation/v3-contracts";
import { printedPercentHeader } from "../label/transcript/format-panel.js";
import { transcriptCandidate } from "./protocol/label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./protocol/label-transcript-wire.js";

/**
 * KAN-243 replay (owner rule: simulate old vs new on stored answers before changing a label rule): every stored
 * amazon.in vision answer in KAN243_INDIA_ANSWERS (R2 `v3/vision/<op>/response.json`, kept out of git), read again
 * by today's rules. Writes each copy's parse and the percentage header the answer now names to KAN243_REPLAY_OUT;
 * asserts that every copy printing a %RDA column keeps it.
 */
const dir = process.env["KAN243_INDIA_ANSWERS"];
const formats = MARKETPLACE_LABEL_FORMATS["amazon.in"] ?? [];

function attempts() {
  return readdirSync(dir ?? "")
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const body = JSON.parse(readFileSync(join(dir ?? "", name), "utf8"));
      const answer = typeof body.raw === "string" ? JSON.parse(body.raw) : body.raw;
      const raw = answer.transcriptAttempt?.raw ?? null;
      return raw ? [{ name: name.slice(0, 10), answer, raw: String(raw) }] : [];
    });
}

describe.skipIf(!dir)("stored amazon.in answers replayed with today's rules", () => {
  it("keeps the copied %RDA header on every answer whose copy prints one", () => {
    const lines: string[] = [];
    for (const { name, answer, raw } of attempts()) {
      const wire = labelTranscriptWireSchema.parse(JSON.parse(raw));
      const header = printedPercentHeader(wire.panels, formats);
      const built = transcriptCandidate(wire, answer.policy, formats);
      const parsed = "reason" in built ? `copy not parsed: ${built.reason}` : "parsed";
      lines.push(`${name} ${answer.codec} | ${parsed} | header ${JSON.stringify(header)}`);
      if (wire.panels.length === 1 && /rda/i.test(wire.panels[0]?.columnHeaders.join(" ") ?? "")) {
        expect(header, name).toMatch(/rda/i);
      }
    }
    writeFileSync(process.env["KAN243_REPLAY_OUT"] ?? "/dev/null", `${lines.join("\n")}\n`);
  });
});
