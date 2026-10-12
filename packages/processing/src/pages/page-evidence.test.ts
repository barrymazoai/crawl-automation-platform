import { expect, it } from "vitest";
import { AppError } from "@crawl-automation/platform";
import { pageSetup } from "../testing/page-fixture.js";
import { defined } from "../testing/defined.js";

it.each([
  [new TypeError("Invalid prepared document"), "PAGE.UNRESOLVED", null],
  [
    new AppError("OCR.EMPTY", "PROCESSING", { message: "Empty OCR result" }),
    "PAGE.UNRESOLVED",
    "OCR.EMPTY",
  ],
  [
    new AppError("ARTIFACT.INTEGRITY", "ARTIFACT", { message: "Hash mismatch" }),
    "ARTIFACT.INTEGRITY",
    "ARTIFACT.INTEGRITY",
  ],
] as const)(
  "keeps a bounded cause without changing the page code (%#)",
  async (error, code, original) => {
    const setup = pageSetup();
    const out = await setup.evidence.review(setup.input, "page.prepare", error);
    expect(out).toMatchObject({ code, automaticRetry: false });
    expect(defined(setup.records.get(out.reviewId)).rawError.details).toMatchObject({
      cause: { code: original, name: error.name, message: error.message },
    });
  },
);
