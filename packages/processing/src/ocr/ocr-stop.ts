import { ocrStopCause } from "./ocr-stop-cause.js";
import {
  provePermitExecutionStopped,
  type PermitExecutionIdentity,
} from "@crawl-automation/platform";
import type { OcrApiSettings } from "./ocr-api-settings.js";

export type OcrExecutionIdentity = Extract<PermitExecutionIdentity, { kind: "ocr" }>;

/** Only configure an adapter when the provider accepts this ID before execution starts. */
export interface OcrJobControl {
  requestHeaders(jobId: string): Record<string, string>;
  query(jobId: string, signal: AbortSignal): Promise<"running" | "stopped" | "unknown">;
  cancel(jobId: string, signal: AbortSignal): Promise<void>;
}

export interface OcrStopResult {
  stopped: boolean;
  attempts: number;
  reason?: string;
  cause?: string;
}

/** A separate deadline survives cancellation of /ocr; elapsed time never establishes stop proof. */
export async function verifyOcrStop(at: {
  identity: OcrExecutionIdentity;
  control: OcrJobControl | undefined;
  settings: OcrApiSettings;
  /** Recovery checks the exact job once, without cancellation or polling. */
  queryOnly?: boolean;
}): Promise<OcrStopResult> {
  const { identity, control, settings } = at;
  if (!control || !supportsControl(identity, settings)) {
    return { stopped: false, attempts: 0, reason: "job_control_unavailable" };
  }
  const signal = AbortSignal.timeout(
    at.queryOnly
      ? Math.min(10_000, settings.stopVerificationTimeoutMs)
      : settings.stopVerificationTimeoutMs,
  );
  let attempts = 0;
  try {
    while (!signal.aborted) {
      attempts++;
      const state = await boundedControl(() => control.query(identity.executionId, signal), signal);
      if (state === "stopped") {
        const proof = { kind: "ocr-job-stopped", observedAt: new Date().toISOString(), attempts };
        await boundedControl(() => provePermitExecutionStopped(identity, proof), signal);
        return { stopped: true, attempts };
      }
      if (at.queryOnly) {
        return { stopped: false, attempts, reason: `job_${state}` };
      }
      if (attempts === 1) {
        await boundedControl(() => control.cancel(identity.executionId, signal), signal);
      } else {
        await pollDelay(settings.stopVerificationPollMs, signal);
      }
    }
    return { stopped: false, attempts, reason: "job_not_confirmed_stopped" };
  } catch (error) {
    return { stopped: false, attempts, reason: "job_control_failed", cause: ocrStopCause(error) };
  }
}

async function pollDelay(milliseconds: number, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await boundedControl(
      () =>
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Bounds even an adapter that ignores AbortSignal. The business OCR call is never retried. */
async function boundedControl<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function supportsControl(identity: OcrExecutionIdentity, settings: OcrApiSettings): boolean {
  return identity.endpoint === settings.baseUrl && identity.metadata?.jobControlSupported === true;
}
