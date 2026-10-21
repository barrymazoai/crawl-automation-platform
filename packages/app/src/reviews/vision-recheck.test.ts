import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReviewRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { hashString } from "@crawl-automation/processing";
import { TextAnswerRecheck } from "./text-recheck.js";

const corpus = new URL(
  "../../../../tools/diag-corpus/amount-state/vision-fc397c07-85ea-4d49-b110-132ccfb620bb.json",
  import.meta.url,
);
const failingCorpus = new URL(
  "../../../../tools/diag-corpus/amount-state/vision-ebb37f9f-3f05-4bee-94dc-460384c912f4.json",
  import.meta.url,
);

function retained(file = corpus) {
  const entry = JSON.parse(readFileSync(file, "utf8")) as {
    review: unknown;
    files: { key: string; content: unknown }[];
  };
  const review = ReviewRecordSchema.parse(entry.review);
  const response = entry.files.find((file) => file.key === review.failure.evidenceKey)?.content;
  if (!response) {
    throw new Error("corpus response missing");
  }
  return { review, response };
}

function reader(review: ReviewRecord, response: unknown) {
  const objects = {
    read: async (key: string) =>
      key === review.failure.evidenceKey ? Buffer.from(JSON.stringify(response)) : null,
  };
  return new TextAnswerRecheck({
    objects,
    sources: {
      resolve: async () => {
        throw new Error("text source used");
      },
    },
  });
}

describe.skipIf(!existsSync(corpus))("retained vision Review recheck", () => {
  it("passes the Sambucol Day/Night answer under today's rules", async () => {
    const { review, response } = retained();
    expect(await reader(review, response).check(review, AbortSignal.timeout(5_000))).toMatchObject({
      reviewId: review.reviewId,
      recordedCode: "VISION.LABEL_AMOUNT_STATE_CONFLICT",
      status: "passes",
      code: null,
    });
  });

  it("returns today's failure code for a still invalid retained answer", async () => {
    const { review, response } = retained();
    const saved = response as { raw: string; fingerprint: string; sha256: string };
    const envelope = JSON.parse(saved.raw);
    const wire = JSON.parse(envelope.raw);
    wire.label.formula.columns[0].rows[1].amountStatus = "not_applicable";
    envelope.raw = JSON.stringify(wire);
    const raw = JSON.stringify(envelope);
    const changed = { ...saved, raw, sha256: hashString(raw) };
    expect(await reader(review, changed).check(review, AbortSignal.timeout(5_000))).toMatchObject({
      status: "fails",
      code: "VISION.LABEL_AMOUNT_STATE_CONFLICT",
    });
  });

  it.skipIf(!existsSync(failingCorpus))(
    "reports today's code for another real Review",
    async () => {
      const { review, response } = retained(failingCorpus);
      expect(
        await reader(review, response).check(review, AbortSignal.timeout(5_000)),
      ).toMatchObject({
        status: "fails",
        code: "VISION.LABEL_AMOUNT_STATE_CONFLICT",
      });
    },
  );

  it("does not accept a response tied to another task", async () => {
    const { review, response } = retained();
    const changed = { ...(response as object), fingerprint: "f".repeat(64) };
    expect(await reader(review, changed).check(review, AbortSignal.timeout(5_000))).toMatchObject({
      status: "unavailable",
      code: "RECHECK.IDENTITY_CONFLICT",
    });
  });
});
