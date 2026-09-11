import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** Acceptance harness only: operator attestation, not automatic CAPTCHA detection or success. */
export function operatorReadyGate(input: Readable, signal: AbortSignal, timeoutMs = 600_000): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("OPERATOR_ABORTED"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    return Promise.reject(new Error("OPERATOR_TIMEOUT_INVALID"));
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input, terminal: false });
    const finish = (code?: string) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      lines.removeListener("line", lineReceived);
      lines.removeListener("close", closed);
      lines.removeListener("error", failed);
      lines.close();
      input.pause();
      if (code) reject(new Error(code)); else resolve();
    };
    const aborted = () => finish("OPERATOR_ABORTED");
    const lineReceived = (line: string) => finish(line === "PRODUCT_613701_READY" ? undefined : "OPERATOR_NOT_READY");
    const closed = () => finish("OPERATOR_INPUT_CLOSED");
    const failed = () => finish("OPERATOR_INPUT_FAILED");
    const timer = setTimeout(() => finish("OPERATOR_TIMEOUT"), timeoutMs);
    lines.once("line", lineReceived);
    lines.once("close", closed);
    lines.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
