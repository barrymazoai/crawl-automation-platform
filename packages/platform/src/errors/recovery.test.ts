import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ignoreAbort } from "./ignore-abort.js";
import { withCause } from "./with-cause.js";
import { platformErrors } from "./platform-errors.js";
import { recordRecovery } from "../logger/recovery.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger/create-logger.js", () => ({ createLogger: () => ({ warn }) }));

describe("recovery diagnostics", () => {
  it("records the exact error with its registered code and run identity", () => {
    const cause = new Error("socket reset");
    const error = platformErrors.create("DATABASE.UNAVAILABLE", { cause });
    recordRecovery(error, { runId: "run-1", operation: "read" });
    expect(warn).toHaveBeenLastCalledWith(
      { runId: "run-1", operation: "read", code: "DATABASE.UNAVAILABLE", err: error },
      expect.any(String),
    );
    expect(warn.mock.lastCall?.[0].err.cause).toBe(cause);
  });

  it("retains uncoded failures under a registered diagnostic code", () => {
    const error = new SyntaxError("invalid retained JSON");
    recordRecovery(error, { operation: "parse" });
    expect(warn.mock.lastCall?.[0]).toMatchObject({ code: "RUNTIME.RECOVERY_FAILED", err: error });
  });

  it("preserves causes without constructing a self-referential chain", () => {
    const original = new Error("transport");
    const wrapped = withCause(new Error("handoff"), original);
    expect(wrapped.cause).toBe(original);
    expect(withCause(original, original).cause).toBeUndefined();
  });

  it("swallows only the expected ABORT_ERR from a stopped Node timer", async () => {
    await expect(
      delay(1000, undefined, { signal: AbortSignal.abort() }).catch(ignoreAbort),
    ).resolves.toBeUndefined();
    const failure = Object.assign(new Error("AbortError"), { code: "EIO" });
    expect(() => ignoreAbort(failure)).toThrow(failure);
  });
});
