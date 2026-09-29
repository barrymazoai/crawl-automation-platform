import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "./app-error.js";
import { defineErrors } from "./define-errors.js";

const errors = defineErrors({
  "RUN.NOT_FOUND": { category: "VALIDATION", message: "Run not found." },
  "RUN.SOURCE_BUSY": { category: "VALIDATION", message: "Source already has an active run." },
});

describe("defineErrors", () => {
  it("creates an AppError with the code's category and message", () => {
    const error = errors.create("RUN.NOT_FOUND", { details: { runId: "abc" } });

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "RUN.NOT_FOUND",
      category: "VALIDATION",
      message: "Run not found.",
      details: { runId: "abc" },
    });
  });

  it("keeps the cause", () => {
    const cause = new Error("socket closed");

    expect(errors.create("RUN.SOURCE_BUSY", { cause }).cause).toBe(cause);
  });

  it("recognises its own codes and nothing else", () => {
    const error = errors.create("RUN.SOURCE_BUSY");

    expect(errors.is(error, "RUN.SOURCE_BUSY")).toBe(true);
    expect(errors.is(error, "RUN.NOT_FOUND")).toBe(false);
    expect(errors.is(new Error("RUN.SOURCE_BUSY"), "RUN.SOURCE_BUSY")).toBe(false);
    expect(isAppError(error)).toBe(true);
  });
});
