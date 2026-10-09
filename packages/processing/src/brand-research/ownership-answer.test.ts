import { describe, expect, it } from "vitest";
import { checkOwnershipAnswer } from "./ownership-answer.js";
import { brand, clue } from "./fixtures.test-support.js";
import type { ReviewerInput } from "./inputs.js";

const input: ReviewerInput = {
  brand,
  clues: [clue],
  checkedUrls: ["https://sprout.example/about"],
};
const owner = {
  verdict: "owner",
  ownerName: clue.ownerName,
  ownerDomain: clue.ownerDomain,
  kind: "brand_of",
  confidence: 0.9,
  signals: [clue.signal],
  reason: `The owner's own listing states "${clue.quote}" (${clue.url}).`,
};
const independent = {
  verdict: "independent",
  confidence: 0.8,
  reason: "Checked the official pages; no credible ownership clue.",
};

describe("ownership answer grounding", () => {
  it("accepts one strong signal with its verbatim quote and URL", () => {
    expect(checkOwnershipAnswer(owner, input)).toEqual(owner);
  });
  it("requires checked pages for independence and refuses ignoring strong evidence", () => {
    expect(checkOwnershipAnswer(independent, { ...input, clues: [] })).toEqual(independent);
    expect(() =>
      checkOwnershipAnswer(independent, { brand, clues: [], checkedUrls: [] }),
    ).toThrow();
    expect(() => checkOwnershipAnswer(independent, input)).toThrow();
  });
  it("allows a reviewer to dismiss weak clues, rather than treating all clues as ownership", () => {
    expect(
      checkOwnershipAnswer(independent, { ...input, clues: [{ ...clue, signal: "web_search" }] }),
    ).toEqual(independent);
  });
  it.each([
    { ownerName: "Invented owner" },
    { ownerDomain: "invented.example" },
    { signals: ["apollo_parent"] },
    { confidence: 2 },
    { reason: "I think so." },
  ])("refuses unsupported or malformed owner verdicts", (change) => {
    expect(() => checkOwnershipAnswer({ ...owner, ...change }, input)).toThrow(
      expect.objectContaining({ code: "BRAND_RESEARCH.ANSWER_INVALID" }),
    );
  });
  it.each(["Manufactured by Garden Group", "Distributed by Garden Group"])(
    "does not turn %s into ownership",
    (quote) => {
      expect(() =>
        checkOwnershipAnswer(
          { ...owner, reason: `${quote} ${clue.url}` },
          { ...input, clues: [{ ...clue, quote }] },
        ),
      ).toThrow();
    },
  );
  it("allows cannot_tell without fabricating research or an owner", () => {
    const answer = { verdict: "cannot_tell", reason: "No source establishes the relationship." };
    expect(checkOwnershipAnswer(answer, { brand, clues: [], checkedUrls: [] })).toEqual(answer);
  });
});
