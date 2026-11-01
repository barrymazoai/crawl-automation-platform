import { expect, it } from "vitest";
import type { HtmlCaptureRequest, SavedHtmlOriginal } from "@crawl-automation/app";
import { captureCreditCost, sameCaptureOperation } from "./html-capture-cost.js";

it("counts the second session as this capture instead of a free reuse", () => {
  const request = {
    channel: "amazon",
    capture: { operationId: "capture-1", sessionId: "capture-1" },
  } as HtmlCaptureRequest;
  const retry = {
    capture: { operationId: "capture-1-other-offer-abc", sessionId: "capture-1" },
  } as SavedHtmlOriginal;
  const unrelated = {
    capture: { operationId: "other-capture", sessionId: "other-capture" },
  } as SavedHtmlOriginal;
  expect(sameCaptureOperation(request, retry)).toBe(true);
  expect(captureCreditCost(request, retry)).toBeNull(); // no measurement context in this test
  expect(sameCaptureOperation(request, unrelated)).toBe(false);
  expect(captureCreditCost(request, unrelated)).toBe(0);
});
