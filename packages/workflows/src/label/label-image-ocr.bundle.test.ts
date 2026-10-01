import { expect, it } from "vitest";
import { currentBundle, withoutPatches } from "../testing/replay/bundles.js";
import { ocrFailureMarker } from "./ocr-walk-fixture.js";

it("bundles the OCR patch and retains the original request branch for replay recording", async () => {
  const current = await currentBundle();
  expect(current.code).toContain(ocrFailureMarker);
  const legacy = withoutPatches(current, [ocrFailureMarker]);
  expect(legacy.code).not.toBe(current.code);
  expect(legacy.code.length).toBe(current.code.length);
}, 60_000);
