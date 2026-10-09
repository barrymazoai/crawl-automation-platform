import { describe, expect, it } from "vitest";
import { checkTitleAnswer } from "./title-answer.js";

const input = {
  titles: ["VP of Sales", "Unknown role"],
  taxonomy: { functions: ["Sales"], levels: ["VP"] },
};
const item = { title: "VP of Sales", function: "Sales", level: "VP" };

describe("title answer taxonomy", () => {
  it("accepts exact taxonomy labels and permits abstention", () => {
    expect(checkTitleAnswer({ items: [item] }, input)).toEqual([item]);
    expect(checkTitleAnswer({ items: [] }, input)).toEqual([]);
  });
  it.each([
    { ...item, function: "Sales & Marketing" },
    { ...item, level: "Vice President" },
    { ...item, title: "Invented role" },
    { ...item, level: null },
  ])("rejects invented or off-list data", (bad) => {
    expect(() => checkTitleAnswer({ items: [bad] }, input)).toThrow(
      expect.objectContaining({ code: "BRAND_RESEARCH.ANSWER_INVALID" }),
    );
  });
  it("refuses duplicate title rows and malformed JSON", () => {
    expect(() => checkTitleAnswer({ items: [item, item] }, input)).toThrow();
    expect(() => checkTitleAnswer("broken", input)).toThrow();
  });
});
