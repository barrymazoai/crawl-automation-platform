import { describe, expect, it, vi } from "vitest";
import type { OcrRegistration } from "@crawl-automation/v3-contracts";
import { MemoryReviews } from "../testing/memory-ledgers.js";
import { MemoryStore } from "../testing/memory-store.js";
import { ocrStepSetup, remoteArtifacts, signal } from "../testing/ocr-fixture.js";
import { KeywordScreening, keywordKey } from "./keyword-screening.js";
import { LedgerOcrText } from "./ocr-text.js";

/** A registered OCR result with the given text, and keyword screening wired to it. */
async function screeningSetup(text = "  Supplement Facts\nIngredients: test only.  ") {
  const fixture = ocrStepSetup();
  fixture.api.recognize = async () => ({ text, lines: [] });
  await fixture.step.run(fixture.input, signal());
  const registration = (await fixture.registry.read(fixture.input.operationId)) as OcrRegistration;
  const ocrText = new LedgerOcrText({
    artifacts: remoteArtifacts(fixture.remote),
    results: fixture.results,
    registry: fixture.registry,
  });
  const local = new MemoryStore();
  const reviews = new MemoryReviews();
  const screening = new KeywordScreening({ text: ocrText, local, remote: fixture.remote, reviews });
  return { ...fixture, registration, ocrText, local, keywordReviews: reviews, screening };
}

// Cases carried over from the former keyword publication and keyword role.
describe("keyword screening step", () => {
  it.each(["Supplement Facts per scoop", "marketing only"])(
    "publishes the decision for %j once",
    async (text) => {
      const fixture = await screeningSetup(text);
      const receipt = await fixture.screening.run(fixture.registration, signal());
      expect(receipt).toMatchObject({
        status: text === "marketing only" ? "not_matched" : "matched",
      });
      const evidenceKey = (receipt as { evidenceKey: string }).evidenceKey;
      expect(fixture.remote.data.has(evidenceKey)).toBe(true);
      expect(JSON.stringify(receipt)).not.toContain(text);
      const writes = fixture.remote.writes;
      const fresh = new KeywordScreening({
        text: fixture.ocrText,
        local: new MemoryStore(),
        remote: fixture.remote,
        reviews: fixture.keywordReviews,
      });
      expect(await fresh.run(fixture.registration, signal())).toEqual(receipt);
      expect(fixture.remote.writes).toBe(writes);
    },
  );

  it("a lost publication acknowledgement is read back, not uploaded again", async () => {
    const fixture = await screeningSetup();
    const writes = fixture.remote.writes;
    fixture.remote.loseAcknowledgements = true;
    expect(await fixture.screening.run(fixture.registration, signal())).toMatchObject({
      status: "matched",
    });
    expect(fixture.remote.writes).toBe(writes + 1);
  });

  it("an unfinished or damaged publication is a Review, never a no-match", async () => {
    const fixture = await screeningSetup("marketing only");
    const create = fixture.remote.create.bind(fixture.remote);
    const failing = vi.spyOn(fixture.remote, "create").mockRejectedValue(new Error("offline"));
    expect(await fixture.screening.run(fixture.registration, signal())).toMatchObject({
      status: "review",
    });
    failing.mockImplementation(create);
    expect(await fixture.screening.run(fixture.registration, signal())).toMatchObject({
      code: "SCREEN.HANDOFF_PENDING",
    });
    const selection = await fixture.ocrText.screen(fixture.registration, signal());
    fixture.remote.data.set(keywordKey(selection), Buffer.from("corrupt"));
    expect(await fixture.screening.run(fixture.registration, signal())).toMatchObject({
      code: "SCREEN.PUBLICATION_CONFLICT",
    });
  });

  it("an OCR result that is not registered is a Review, kept locally first", async () => {
    const fixture = await screeningSetup();
    fixture.registry.data.clear();
    const outcome = await fixture.screening.run(fixture.registration, signal());
    expect(outcome).toMatchObject({
      status: "review",
      code: "SCREEN.UPSTREAM_UNVERIFIED",
      automaticRetry: false,
    });
    const review = fixture.keywordReviews.records.get((outcome as { reviewId: string }).reviewId);
    expect(review?.failure).toMatchObject({
      stage: "ocr.keywords",
      evidenceKey: fixture.registration.result.objectKey,
    });
    expect(fixture.local.data.has(`keyword-reviews/${review?.reviewId}.json`)).toBe(true);
  });
});
