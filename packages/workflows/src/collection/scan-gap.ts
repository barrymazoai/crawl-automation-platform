import { CancellationScope, isCancellation, sleep } from "@temporalio/workflow";

/** A channel signals cooling through a result or serialized ApplicationFailure details. */
function requestsCooldown(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const outcome = value as { cooldownRequested?: unknown; details?: unknown; cause?: unknown };
  return (
    outcome.cooldownRequested === true ||
    (Array.isArray(outcome.details) && outcome.details.some(requestsCooldown)) ||
    requestsCooldown(outcome.cause)
  );
}

/** Stay inside the resource gate for every outcome. Cancellation interrupts or skips the timer. */
export async function readWithScanGap(
  read: () => Promise<unknown>,
  settings: { gapAfterSeconds: number; cooldownSeconds?: number },
) {
  let seconds = settings.gapAfterSeconds;
  let cancelled = false;
  const delayFor = (value: unknown) => {
    if (requestsCooldown(value)) {
      seconds = Math.max(seconds, settings.cooldownSeconds ?? 0);
    }
  };
  try {
    const result = await read();
    delayFor(result);
    return result;
  } catch (error) {
    cancelled = isCancellation(error);
    delayFor(error);
    throw error;
  } finally {
    if (seconds > 0 && !cancelled && !CancellationScope.current().consideredCancelled) {
      await sleep(seconds * 1000);
    }
  }
}
