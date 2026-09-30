import { CodexError } from "@crawl-automation/platform";
import { describe, expect, it } from "vitest";
import { executionFactOf, isKnownTextFailure, textFailure } from "./errors.js";

describe("text failures", () => {
  it("keep whether the model ran, and the code of the error that caused them", () => {
    const failure = textFailure(
      "TEXT.EVIDENCE_UNAVAILABLE",
      "not_executed",
      new CodexError("TEXT.CODEX_TIMEOUT"),
    );

    expect(failure.code).toBe("TEXT.EVIDENCE_UNAVAILABLE");
    expect(failure.details).toMatchObject({
      executionFact: "not_executed",
      cause: "TEXT.CODEX_TIMEOUT",
    });
    expect(executionFactOf(failure)).toBe("not_executed");
  });

  it("the model client's errors are known and carry their own execution fact", () => {
    const error = new CodexError("TEXT.CODEX_TURN_FAILED", "executed");

    expect(isKnownTextFailure(error)).toBe(true);
    expect(executionFactOf(error)).toBe("executed");
  });

  it("an unrelated error is unknown, even with look-alike fields", () => {
    const lookAlike = Object.assign(new Error("x"), {
      code: "TEXT.OUTPUT_LIMIT",
      executionFact: "executed",
    });

    expect(isKnownTextFailure(lookAlike)).toBe(false);
    expect(executionFactOf(lookAlike)).toBeNull();
  });
});
