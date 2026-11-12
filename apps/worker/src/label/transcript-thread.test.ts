import { describe, expect, it } from "vitest";
import { threadedTranscriptParser } from "./transcript-thread.js";

const fixture = (name: string) => new URL(`./testing/${name}`, import.meta.url).href;

describe("label copy parse on a time-limited thread (KAN-243, 2026-11-12)", () => {
  it("returns a step's value and rebuilds its AppError with the code", async () => {
    const parser = threadedTranscriptParser({ filename: fixture("parse-echo.mjs") });
    try {
      expect(await parser.run("decode", ["answer"])).toEqual({ op: "decode", first: "answer" });
      await expect(parser.run("decode", ["fail"])).rejects.toMatchObject({
        name: "AppError",
        code: "VISION.INVALID_OUTPUT",
      });
    } finally {
      await parser.close();
    }
  });

  it("ends a step that never returns with its own error, and the pool keeps serving", async () => {
    const hanging = threadedTranscriptParser({
      filename: fixture("parse-hang.mjs"),
      timeoutMs: 300,
    });
    const started = performance.now();
    try {
      await expect(hanging.run("decode", ["answer"])).rejects.toMatchObject({
        code: "VISION.LABEL_PARSE_TIMEOUT",
      });
      expect(performance.now() - started).toBeLessThan(5_000);
      // The terminated thread is replaced: the next step is not stuck behind it.
      await expect(hanging.run("decode", ["answer"])).rejects.toMatchObject({
        code: "VISION.LABEL_PARSE_TIMEOUT",
      });
    } finally {
      await hanging.close();
    }
  }, 20_000);
});
