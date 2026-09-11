import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { operatorReadyGate } from "./operator-ready-gate.js";
afterEach(() => vi.useRealTimers());
it("requires the exact product readiness statement and removes input listeners", async () => {
  const input = new PassThrough();
  const result = operatorReadyGate(input, new AbortController().signal);
  input.write("PRODUCT_613701_"); input.write("READY\n");
  await result; expect(input.listenerCount("data")).toBe(0);
});
it.each(["\n", "continue\n", "PRODUCT_613702_READY\n"])("rejects non-attestation %j", async value => {
  const input = new PassThrough(); const result = operatorReadyGate(input, new AbortController().signal);
  input.write(value); await expect(result).rejects.toThrow("OPERATOR_NOT_READY");
});
it("closed stdin never starts a workflow", async () => {
  const input = new PassThrough(); const result = operatorReadyGate(input, new AbortController().signal);
  input.end(); await expect(result).rejects.toThrow("OPERATOR_INPUT_CLOSED");
});
it("timeout rejects and releases input", async () => {
  vi.useFakeTimers(); const input = new PassThrough();
  const result = operatorReadyGate(input, new AbortController().signal, 100);
  const check = expect(result).rejects.toThrow("OPERATOR_TIMEOUT");
  await vi.advanceTimersByTimeAsync(100); await check; expect(input.listenerCount("data")).toBe(0);
});
it("abort rejects without continuing", async () => {
  const input = new PassThrough(), controller = new AbortController();
  const result = operatorReadyGate(input, controller.signal); controller.abort();
  await expect(result).rejects.toThrow("OPERATOR_ABORTED");
  await expect(operatorReadyGate(input, controller.signal)).rejects.toThrow("OPERATOR_ABORTED");
});
