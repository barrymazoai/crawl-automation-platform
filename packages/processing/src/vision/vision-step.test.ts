import { describe, expect, it } from "vitest";
import { defined } from "../testing/defined.js";
import { MemoryStore } from "../testing/memory-store.js";
import {
  labelAnswer,
  legacyCandidate,
  selection,
  signal,
  visionSetup,
} from "../testing/vision-fixture.js";
import { CodexError } from "@crawl-automation/v3-codex";
import { visionKeys } from "./vision-files.js";
import type { VisionOutcome } from "./vision-outcome.js";
import { VisionStep } from "./vision-step.js";

const reviewOf = (fixture: ReturnType<typeof visionSetup>, outcome: VisionOutcome) =>
  fixture.reviews.records.get(outcome.status === "review" ? outcome.reviewId : "");

// Cases carried over from the former vision module, handoff and label-execution tests.
describe("vision step", () => {
  it("keeps the raw answer locally and in R2, registers it, and reports only references", async () => {
    const fixture = visionSetup();
    const outcome = await fixture.step.run(fixture.task, signal());
    expect(outcome).toMatchObject({ status: "registered", candidateStatus: "candidate" });
    expect(fixture.model.calls).toBe(1);
    const key = visionKeys.response(fixture.task);
    expect(fixture.local.data.get(key)).toEqual(fixture.remote.data.get(key));
    expect(await fixture.registry.read(fixture.task.input.operationId)).toMatchObject({
      codec: "vision-result/2",
    });
    expect(JSON.stringify(outcome)).not.toContain("Amounts Per Serving");
  });

  it("a repeated delivery reuses the registered result, even on a new node with an empty local store", async () => {
    const fixture = visionSetup();
    const first = await fixture.step.run(fixture.task, signal());
    const writes = fixture.remote.writes;
    const cold = new VisionStep({ ...fixture.deps, local: new MemoryStore() });
    expect(await cold.run(fixture.task, signal())).toEqual(first);
    expect([fixture.model.calls, fixture.remote.writes]).toEqual([1, writes]);
  });

  it("concurrent deliveries call the model at most once", async () => {
    const fixture = visionSetup();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => fixture.step.run(fixture.task, signal())),
    );
    expect(fixture.model.calls).toBe(1);
    expect(outcomes.some((outcome) => outcome.status === "registered")).toBe(true);
  });

  it("an unverified OCR selection never reaches the model", async () => {
    const fixture = visionSetup();
    fixture.ocr.verified = false;
    const outcome = await fixture.step.run(fixture.task, signal());
    expect(outcome).toMatchObject({ status: "review", code: "VISION.EVIDENCE_UNRESOLVED" });
    expect(reviewOf(fixture, outcome)?.failure.executionFact).toBe("not_executed");
    expect([fixture.model.calls, fixture.remote.writes]).toEqual([0, 0]);
  });

  it("a task for another setup or protocol is refused before any read", async () => {
    const fixture = visionSetup();
    const other = { ...fixture.task, configFingerprint: "b".repeat(64) };
    await expect(fixture.step.run(other, signal())).rejects.toMatchObject({
      code: "VISION.CONFIG_MISMATCH",
    });
    const legacy = {
      ...fixture.task,
      input: { operationId: "vision-legacy", selection: selection() },
    };
    await expect(fixture.step.run(legacy, signal())).rejects.toMatchObject({
      code: "VISION.CONFIG_MISMATCH",
    });
    expect(fixture.model.calls).toBe(0);
  });

  it("an intent with no answer behind it is unknown, and never runs the model again", async () => {
    const fixture = visionSetup();
    fixture.model.interpret = async () => new Promise<string>(() => undefined);
    const controller = new AbortController();
    const hung = fixture.step.run(fixture.task, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const redelivered = new VisionStep({ ...fixture.deps, local: new MemoryStore() });
    expect(await redelivered.run(fixture.task, signal())).toMatchObject({
      code: "VISION.EXECUTION_UNKNOWN",
    });
    controller.abort();
    void hung.catch(() => undefined);
  });

  it("a failed model call keeps its code, fact and Codex's words, and a redelivery reports the same", async () => {
    const fixture = visionSetup();
    fixture.model.interpret = async () => {
      throw new CodexError("VISION.CODEX_TURN_FAILED", "unknown", "rate limit reached");
    };
    const outcome = await fixture.step.run(fixture.task, signal());
    expect(outcome).toMatchObject({
      code: "VISION.CODEX_TURN_FAILED",
      evidenceKey: visionKeys.failure(fixture.task),
    });
    expect(reviewOf(fixture, outcome)?.rawError.details).toMatchObject({
      cause: "rate limit reached",
    });
    const again = await fixture.step.run(fixture.task, signal());
    expect(again).toMatchObject({ code: "VISION.CODEX_TURN_FAILED" });
    expect(reviewOf(fixture, again)?.rawError.details).toMatchObject({
      cause: "rate limit reached",
    });
  });

  it("an unreadable answer is a Review, and the answer is still kept in R2 for inspection", async () => {
    const fixture = visionSetup({ answer: "not json" });
    const outcome = await fixture.step.run(fixture.task, signal());
    expect(outcome).toMatchObject({ status: "review", code: "VISION.INVALID_OUTPUT" });
    expect(reviewOf(fixture, outcome)?.failure.executionFact).toBe("executed");
    expect(fixture.remote.data.has(visionKeys.response(fixture.task))).toBe(true);
  });

  it("an answer failing a label check is a Review with the decoded candidate, never registered", async () => {
    const label = JSON.parse(labelAnswer());
    label.formula.columns[0].rows[14].amount = null;
    const fixture = visionSetup({ answer: JSON.stringify(label) });
    const outcome = await fixture.step.run(fixture.task, signal());
    expect(outcome.status).toBe("review");
    expect((outcome as { code: string }).code).toMatch(/^VISION\.LABEL_/);
    expect(reviewOf(fixture, outcome)?.candidate).toMatchObject({ schema: "label-extraction/1" });
    expect(fixture.registry.writes).toBe(0);
  });

  it("an old-format answer is never read as a label answer", async () => {
    const fixture = visionSetup({ answer: JSON.stringify(legacyCandidate) });
    expect(await fixture.step.run(fixture.task, signal())).toMatchObject({
      code: "VISION.INVALID_OUTPUT",
    });
  });

  it("an oversized answer is a Review without a candidate", async () => {
    const fixture = visionSetup({ answer: "x".repeat(260_000) });
    const outcome = await fixture.step.run(fixture.task, signal());
    expect(outcome).toMatchObject({ code: "VISION.OUTPUT_LIMIT" });
    expect(reviewOf(fixture, outcome)?.candidate).toBeNull();
  });

  it("an R2 outage keeps the answer locally; a redelivery never re-runs or uploads by itself", async () => {
    const fixture = visionSetup();
    const create = fixture.remote.create.bind(fixture.remote);
    fixture.remote.create = async (key, bytes) => {
      if (key === visionKeys.response(fixture.task)) {
        throw new Error("R2 offline");
      }
      return create(key, bytes);
    };
    expect(await fixture.step.run(fixture.task, signal())).toMatchObject({
      code: "VISION.HANDOFF_PENDING",
    });
    expect(fixture.local.data.has(visionKeys.response(fixture.task))).toBe(true);
    fixture.remote.create = create;
    expect(await fixture.step.run(fixture.task, signal())).toMatchObject({
      code: "VISION.HANDOFF_PENDING",
    });
    expect(fixture.model.calls).toBe(1);
    expect(fixture.remote.data.has(visionKeys.response(fixture.task))).toBe(false);
  });

  it("a lost registration acknowledgement is settled by reading it back", async () => {
    const fixture = visionSetup();
    fixture.registry.loseAcknowledgement = true;
    expect(await fixture.step.run(fixture.task, signal())).toMatchObject({ status: "registered" });
    expect([fixture.registry.writes, fixture.reviews.records.size]).toEqual([1, 0]);
  });
});

describe("vision results", () => {
  it.each(["image", "response", "completion"])(
    "a damaged %s in R2 fails a registered replay",
    async (part) => {
      const fixture = visionSetup();
      const outcome = await fixture.step.run(fixture.task, signal());
      const keys: Record<string, string> = {
        image: fixture.task.input.selection.image.objectKey,
        response: visionKeys.response(fixture.task),
        completion: defined((outcome as { completion?: { objectKey: string } }).completion)
          .objectKey,
      };
      fixture.remote.data.set(defined(keys[part]), Buffer.from("damaged"));
      await expect(fixture.results.inspect(fixture.task, signal())).rejects.toThrow();
      expect(fixture.model.calls).toBe(1);
    },
  );

  it("a record under another setup or storage is a conflict", async () => {
    const fixture = visionSetup();
    await fixture.step.run(fixture.task, signal());
    const other = { ...fixture.task, configFingerprint: "c".repeat(64) };
    await expect(fixture.results.inspect(other, signal())).rejects.toMatchObject({
      code: "VISION.RESULT_CONFLICT",
    });
  });
});
