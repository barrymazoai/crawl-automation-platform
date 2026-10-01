import { strict as assert } from "node:assert";
import { z } from "zod";
import { type ReviewRecord, type TextInput } from "@crawl-automation/v3-contracts";
import { decodeLabelText, type DecodedLabel } from "../../text/protocol/label-decoder.js";
import { documentText, textInput, type SavedEvidence } from "./saved-evidence.js";

const RawSchema = z.object({ rawResponse: z.string() });
export interface ReplayedText {
  review: ReviewRecord;
  input: TextInput;
  decoded?: DecodedLabel;
  error?: string;
}

/** Re-run all raw saved text answers; thrown citation/schema errors remain failures. */
export function replayText(data: SavedEvidence): Map<string, ReplayedText> {
  const answers = new Map<string, ReplayedText>();
  for (const review of data.records.values()) {
    if (review.candidate?.schema !== "text-raw-response/1") {
      continue;
    }
    const input = textInput(data, review.reviewId);
    assert.ok(input, "Raw answer without saved input");
    assert.equal(input.operationId, review.failure.operationId);
    assert.equal(input.inputFingerprint, review.failure.inputFingerprint);
    const answer: ReplayedText = { review, input };
    try {
      const response = RawSchema.parse(review.candidate.value).rawResponse;
      answer.decoded = decodeLabelText({
        scope: input,
        text: documentText(data, input),
        response,
        policyVersion: input.policyVersion,
      });
    } catch (error) {
      answer.error =
        error instanceof Error && "code" in error ? String(error.code) : "schema-or-evidence";
    }
    answers.set(review.reviewId, answer);
  }
  return answers;
}

export function textTotals(answers: Map<string, ReplayedText>) {
  const counts: Record<string, { beforeReview: number; afterReview: number; nowPass: number }> = {};
  for (const answer of answers.values()) {
    const count = (counts[answer.review.failure.code] ??= {
      beforeReview: 0,
      afterReview: 0,
      nowPass: 0,
    });
    count.beforeReview++;
    if (answer.decoded && answer.decoded.status !== "review") {
      count.nowPass++;
    } else {
      count.afterReview++;
    }
  }
  return counts;
}
