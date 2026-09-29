import { storageErrors } from "@crawl-automation/platform";
import { CodexError } from "@crawl-automation/v3-codex";
import { describe, expect, it } from "vitest";
import { signal, textFixture } from "../testing/text-fixture.js";
import { TextStep } from "./text-step.js";

describe("TextStep", () => {
  it("calls the model once, stores the result in R2 and registers it", async () => {
    const given = textFixture();

    const outcome = await given.step.run(given.input, signal());

    expect(outcome).toMatchObject({ status: "registered", operationId: given.input.operationId });
    expect(given.model.calls).toBe(1);
    expect(given.registry.data.has(given.input.operationId)).toBe(true);
  });

  it("a second delivery of the same task reads the stored result and never calls the model again", async () => {
    const given = textFixture();
    await given.step.run(given.input, signal());

    const again = await given.step.run(given.input, signal());

    expect(again.status).toBe("registered");
    expect(given.model.calls).toBe(1);
  });

  it("an unreadable answer becomes a Review that keeps the raw answer and says the model ran", async () => {
    const given = textFixture();
    given.model.interpret = async () => "not json";

    const outcome = await given.step.run(given.input, signal());

    expect(outcome).toMatchObject({ status: "review", code: "TEXT.MODEL_SCHEMA" });
    const review = given.reviews.records.get(outcome.status === "review" ? outcome.reviewId : "");
    expect(review?.failure.executionFact).toBe("executed");
    expect(review?.candidate).toMatchObject({ schema: "text-raw-response/1" });
  });

  it("a model client failure keeps its code, whether the model ran, and what the client reported", async () => {
    const given = textFixture();
    given.model.interpret = async () => {
      throw new CodexError("TEXT.CODEX_TIMEOUT", "unknown", "turn did not finish");
    };

    const outcome = await given.step.run(given.input, signal());

    expect(outcome).toMatchObject({ status: "review", code: "TEXT.CODEX_TIMEOUT" });
    const review = given.reviews.records.get(outcome.status === "review" ? outcome.reviewId : "");
    expect(review?.failure.executionFact).toBe("unknown");
    expect(review?.rawError.details).toMatchObject({ cause: "turn did not finish" });
  });

  it("an unrelated error that merely has a code is recorded as unclassified", async () => {
    const given = textFixture();
    given.model.interpret = async () => {
      throw Object.assign(new Error("boom"), {
        code: "TEXT.OUTPUT_LIMIT",
        executionFact: "executed",
      });
    };

    expect(await given.step.run(given.input, signal())).toMatchObject({
      code: "TEXT.UNCLASSIFIED",
    });
  });

  it("a task for another model setup is refused before the model is called", async () => {
    const given = textFixture();
    const other = { ...given.input, configFingerprint: "b".repeat(64) };

    await expect(given.step.run(other, signal())).rejects.toMatchObject({
      code: "TEXT.INVALID_INPUT",
    });
    expect(given.model.calls).toBe(0);
  });

  it("refuses a model client that could retry or switch models", () => {
    const given = textFixture();
    const unsafe = {
      ...given.model,
      policy: { ...given.model.policy, modelFallback: true as unknown as false },
    };

    expect(
      () =>
        new TextStep({
          model: unsafe,
          results: given.results,
          reviews: given.reviews,
          nodeId: "n",
        }),
    ).toThrow(expect.objectContaining({ code: "TEXT.PROVIDER_POLICY" }));
  });

  it("a lost registration acknowledgement is read back instead of running the model again", async () => {
    const given = textFixture();
    given.registry.loseAcknowledgement = true;

    const outcome = await given.step.run(given.input, signal());

    expect(outcome.status).toBe("registered");
    expect(given.model.calls).toBe(1);
  });

  it("an unavailable ledger leaves the computed result in R2 and the model is not run again", async () => {
    const given = textFixture();
    given.registry.unavailable = true;
    const first = await given.step.run(given.input, signal());
    given.registry.unavailable = false;

    await given.results.register(given.input, signal());

    expect(first.status).toBe("review");
    expect(given.registry.data.has(given.input.operationId)).toBe(true);
    expect(given.model.calls).toBe(1);
  });

  it("a local-store failure before the model call records its own code and does not claim the model never ran", async () => {
    const given = textFixture();
    given.local.read = async () => {
      throw storageErrors.create("STORAGE.TOO_LARGE");
    };

    const outcome = await given.step.run(given.input, signal());

    expect(outcome).toMatchObject({ status: "review", code: "STORAGE.TOO_LARGE" });
    const review = given.reviews.records.get(outcome.status === "review" ? outcome.reviewId : "");
    expect(review?.failure).toMatchObject({ executionFact: "unknown", blockedBy: null });
    expect(given.model.calls).toBe(0);
  });
});
