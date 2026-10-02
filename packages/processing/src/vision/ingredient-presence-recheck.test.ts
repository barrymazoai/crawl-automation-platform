import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@crawl-automation/platform";
import { JPEG } from "../testing/vision-fixture.js";
import { imageSource } from "../testing/label-sources.js";
import { buildStepReview } from "../step/step-review.js";
import { encodeJson } from "../results/result-record.js";
import { recheckFixture, signal } from "../recheck/recheck-fixture.js";
import { RecheckImageSource } from "../recheck/image-source.js";
import { decodeVisionResult } from "./protocol/vision-protocol.js";
import {
  savedOreganoLabel,
  savedPresenceAnswer,
  explicitNoneWire,
} from "./protocol/ingredient-presence-fixture.js";
import {
  visionKeys,
  visionResponse,
  visionTaskFingerprint,
  prepareVisionRecord,
} from "./vision-files.js";

async function savedFixture(raw: string) {
  const base = await recheckFixture();
  const { source } = imageSource(savedOreganoLabel(), 0);
  const { task } = source;
  const image = task.input.selection.image;
  const bytes = JPEG;
  image.mediaType = "image/jpeg";
  image.sha256 = sha256(bytes);
  image.byteSize = bytes.length;
  base.remote.data.set(image.objectKey, bytes);
  const response = encodeJson(visionResponse(task, raw));
  const decoded = decodeVisionResult(task.input, raw);
  const saved = prepareVisionRecord(task, { bytes: response, status: "candidate" }, "test/1");
  base.remote.data.set(saved.record.result.objectKey, response);
  base.remote.data.set(saved.record.completion.objectKey, saved.completion);
  base.remote.data.set(
    visionKeys.intent(task),
    encodeJson({
      input: task.input,
      fingerprint: visionTaskFingerprint(task),
      nonce: randomUUID(),
    }),
  );
  const imageRecords = { read: vi.fn(async () => saved.record) };
  const reader = new RecheckImageSource({ ...base.deps, imageRecords });
  return { ...base, source, decoded, reader, imageRecords };
}

function savedReview(fixture: Awaited<ReturnType<typeof savedFixture>>) {
  const { task } = fixture.source;
  return buildStepReview({
    reviewId: "saved-image-review",
    task: {
      ...task.input.selection.observation,
      operationId: task.input.operationId,
      inputFingerprint: visionTaskFingerprint(task),
    },
    observation: task.input.selection.observation,
    stage: "codex.vision",
    category: "PROCESSING",
    code: "VISION.LABEL_INGREDIENTS_INCOMPLETE",
    fact: "executed",
    evidenceKey: visionKeys.response(task),
    blockedBy: null,
    error: { name: "original-review", details: {} },
    inspection: { kind: "none" },
    candidate: { schema: "label-extraction/1", value: fixture.decoded.candidate },
  });
}

describe("recheck of versioned ingredient-presence answers", () => {
  it.each(["old", "disabled"])(
    "keeps %s Review from stored bytes, with no writes or calls",
    async (mode) => {
      const raw =
        mode === "old"
          ? JSON.stringify(savedOreganoLabel())
          : savedPresenceAnswer(explicitNoneWire(), false);
      const fixture = await savedFixture(raw);
      const review = savedReview(fixture);
      const before = fixture.remote.writes;
      const result = await fixture.reader.read(fixture.source, review, signal());
      expect(result.failure?.code).toBe("VISION.LABEL_INGREDIENTS_INCOMPLETE");
      expect(result.failure?.candidate).toEqual(fixture.decoded.candidate);
      expect(result.entry).toBeUndefined();
      expect(fixture.remote.writes).toBe(before);
      expect(fixture.imageRecords.read).not.toHaveBeenCalled();
      expect(fixture.deps.verifyOcr).toHaveBeenCalledOnce();
    },
  );

  it("re-decodes a registered new answer into identical candidate provenance", async () => {
    const fixture = await savedFixture(savedPresenceAnswer());
    const before = fixture.remote.writes;
    const result = await fixture.reader.read(fixture.source, null, signal());
    expect(result.failure).toBeUndefined();
    expect(result.entry?.candidate).toEqual(fixture.decoded.candidate);
    expect(fixture.remote.writes).toBe(before);
    expect(fixture.deps.verifyOcr).toHaveBeenCalledOnce();
  });
});
