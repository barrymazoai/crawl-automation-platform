import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { labelReviewFailure } from "./text-protocol.js";

/**
 * Every `LABEL.*` code written in the label checks (contracts' assessment and this folder's checks). The contracts
 * source is read as text, not imported: the codes are string literals there, not an exported list.
 */
function labelCodesInSource(): string[] {
  const folders = [
    new URL("../../../../v3-contracts/src/", import.meta.url),
    new URL("./", import.meta.url),
  ];
  const codes = new Set<string>();
  for (const folder of folders) {
    for (const name of readdirSync(folder).filter((file) => /^label.*\.ts$/.test(file))) {
      if (name.endsWith(".test.ts")) {
        continue;
      }
      for (const match of readFileSync(new URL(name, folder), "utf8").matchAll(
        /"(LABEL\.[A-Z_]+)"/g,
      )) {
        codes.add(match[1] ?? "");
      }
    }
  }
  return [...codes].sort();
}

// Thrown before an answer is read, never returned as a check result.
const REFUSALS = new Set(["LABEL.TEXT_LIMIT", "LABEL.TEXT_RANGE"]);

describe("label check codes", () => {
  it("finds the label codes in the source", () => {
    expect(labelCodesInSource()).toContain("LABEL.COVERAGE_UNCERTAIN");
  });

  it.each(labelCodesInSource().filter((code) => !REFUSALS.has(code)))(
    "%s has a registered TEXT.LABEL_ code",
    (labelCode) => {
      expect(labelReviewFailure(labelCode).code).toBe(labelCode.replace(/^LABEL\./, "TEXT.LABEL_"));
    },
  );

  it("an unknown label code is an unreadable answer that keeps the code it had", () => {
    const failure = labelReviewFailure("LABEL.SOMETHING_NEW");

    expect(failure.code).toBe("TEXT.LABEL_INVALID_OUTPUT");
    expect(failure.details["labelCode"]).toBe("LABEL.SOMETHING_NEW");
  });
});
