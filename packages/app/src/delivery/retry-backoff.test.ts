import { describe, expect, it } from "vitest";
import { RetryBackoff } from "./retry-backoff.js";

describe("RetryBackoff", () => {
  it("waits a minute after a failure, doubling up to an hour", () => {
    let now = 0;
    const backoff = new RetryBackoff(() => now);

    const waits = Array.from({ length: 8 }, () => backoff.failed("run-1"));

    expect(waits).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
    expect(backoff.isWaiting("run-1")).toBe(true);
    now = 3_600_001;
    expect(backoff.isWaiting("run-1")).toBe(false);
  });

  it("forgets a request once it succeeds", () => {
    const backoff = new RetryBackoff(() => 0);
    backoff.failed("run-1");

    backoff.succeeded("run-1");

    expect(backoff.isWaiting("run-1")).toBe(false);
    expect(backoff.failed("run-1")).toBe(60_000);
  });
});
