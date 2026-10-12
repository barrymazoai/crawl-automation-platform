import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@crawl-automation/platform";
import { safeErrorSummary, SafeErrorSummarySchema, safeLabelText } from "./error-summary.js";

describe("safe error summaries", () => {
  it("keeps the original code and message through wrappers, without their details or stack", () => {
    const inner = new AppError("ARTIFACT.INTEGRITY", "ARTIFACT", {
      message: "Stored evidence failed integrity verification",
      details: { secret: "private", bytes: new Uint8Array([1]), document: "private page" },
    });
    expect(safeErrorSummary(new Error("wrapper", { cause: inner }))).toEqual({
      code: "ARTIFACT.INTEGRITY",
      name: "AppError",
      message: "Stored evidence failed integrity verification",
    });
  });

  it("retains only ten bounded zod issues, never raw issue input or the JSON error message", () => {
    const error = new z.ZodError(
      Array.from({ length: 12 }, (_, index) => ({
        code: "custom",
        path: ["formula", index, "servingSize"],
        message: "Serving size conflicts with packaging",
        input: "private document",
      })),
    );
    const cause = safeErrorSummary(error);
    expect(cause).toMatchObject({ code: null, name: "ZodError", message: "Validation failed" });
    expect(cause.issues).toHaveLength(10);
    expect(cause.issues?.[0]).toEqual({
      path: ["formula", 0, "servingSize"],
      code: "custom",
      message: "Serving size conflicts with packaging",
    });
    expect(JSON.stringify(cause)).not.toContain("private document");
    expect(SafeErrorSummarySchema.parse(cause)).toEqual(cause);
  });

  it.each([
    "Read failed https://user:private@example.test/object?token=private#private",
    "Read failed /object?signature=private",
    "Read failed Authorization: Bearer private",
    "Read failed password=private",
    "Read failed clientSecret=private",
    "Read failed token private",
    "Read failed\nprivate document",
    'Read failed {"document":"private"}',
    "Read failed <html>private</html>",
    "Read failed data:image/png;base64,private",
    "Read failed bytes: private",
  ])("redacts sensitive message content: %s", (message) => {
    const cause = safeErrorSummary(new Error(message));
    expect(cause.message).toContain("Read failed");
    expect(JSON.stringify(cause)).not.toContain("private");
    expect(JSON.stringify(cause)).not.toContain("?");
  });

  it("handles Temporal causes, including serialized zod issues", () => {
    const issues = [{ path: ["complete"], code: "invalid_type", message: "Expected boolean" }];
    const cause = safeErrorSummary({
      name: "ActivityFailure",
      cause: { name: "ApplicationFailure", type: "ZodError", message: JSON.stringify(issues) },
    });
    expect(cause).toEqual({ code: null, name: "ZodError", message: "Validation failed", issues });
    expect(safeErrorSummary({ name: "ApplicationFailure", type: "ARTIFACT.INTEGRITY" }).code).toBe(
      "ARTIFACT.INTEGRITY",
    );
  });

  it("bounds messages and cycles without serializing arbitrary thrown values", () => {
    expect(safeErrorSummary(new Error("Read failed. ".repeat(100))).message).toHaveLength(300);
    const error = new Error("cycle");
    error.cause = error;
    expect(safeErrorSummary(error).message).toBe("cycle");
    expect(safeErrorSummary({ bytes: [1, 2], document: "private" })).toEqual({
      code: null,
      name: "UnknownError",
      message: "",
    });
  });

  it("reads only a bounded transported cause from activity details", () => {
    const cause = { code: "OCR.EMPTY", name: "SourceReview", message: "OCR.EMPTY" };
    expect(
      safeErrorSummary({
        name: "ActivityFailure",
        cause: {
          name: "ApplicationFailure",
          type: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
          details: [{ cause, document: "private" }],
        },
      }),
    ).toEqual(cause);
  });

  it("bounds and redacts issue paths and messages as well as the error message", () => {
    const cause = safeErrorSummary(
      new z.ZodError([
        {
          code: "custom",
          path: [
            "https://example.test/?token=private",
            ...Array.from({ length: 20 }, () => "segment-".repeat(40)),
          ],
          message: "Invalid value password=private",
        },
      ]),
    );
    expect(JSON.stringify(cause)).not.toContain("private");
    expect(cause.issues?.[0]?.path).toHaveLength(10);
    expect(SafeErrorSummarySchema.parse(cause)).toEqual(cause);
  });

  it("does not let throwing error properties replace the original failure", () => {
    const error = {
      get message() {
        throw new Error("unreadable");
      },
    };
    expect(safeErrorSummary(error)).toEqual({ code: null, name: "UnknownError", message: "" });
  });
});

it("label text keeps quotes and brackets but drops URLs, credentials and markup", () => {
  expect(safeLabelText('row 3 "Huperzine A [1%]": invalid parent 3')).toBe(
    'row 3 "Huperzine A [1%]": invalid parent 3',
  );
  const text = safeLabelText(
    "model reported AMBIGUOUS: <html><b>x</b></html> see https://cdn.test/a.jpg?X-Amz-Signature=abc token=t0k3n",
  );
  for (const leaked of ["<html", "X-Amz-Signature", "cdn.test", "t0k3n"]) {
    expect(text).not.toContain(leaked);
  }
  expect(text).toMatch(/^model reported AMBIGUOUS:/u);
});
