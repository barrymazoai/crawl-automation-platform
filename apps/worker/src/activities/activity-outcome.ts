import { currentMeasurement, recordMeasurement } from "@crawl-automation/platform";
import { z } from "zod";

const outcome = z.object({
  status: z.string().optional(),
  code: z.string().optional(),
  reused: z.boolean().optional(),
});
const receiptSteps = new Set([
  "interpretText",
  "interpretImage",
  "ocrFile",
  "enrichCollectedProduct",
  "resolveTextReceipt",
  "resolveOcrReceipt",
]);

function resultOutcome(result: unknown) {
  const parsed = outcome.safeParse(result);
  if (!parsed.success) {
    return { status: undefined, outcomeCode: "completed", reused: false };
  }
  return {
    reused: parsed.data.reused ?? false,
    status: parsed.data.status,
    outcomeCode: parsed.data.code ?? parsed.data.status ?? "completed",
  };
}

export function activityOutcome(name: string, result: unknown) {
  const { status, outcomeCode, reused: explicitReuse } = resultOutcome(result);
  const events = currentMeasurement()?.events ?? [];
  const providerCall = events.some((event) => event.providerCall);
  const reused = explicitReuse || events.some((event) => event.cacheHit === true);
  const recovered = receiptSteps.has(name) && ["registered", "uploaded"].includes(status ?? "");
  return {
    outcomeCode,
    sourceHash: observedHash(),
    providerCall,
    cacheHit: providerCall ? false : reused || recovered ? true : null,
  };
}

function observedHash(): string | null {
  const active = currentMeasurement();
  return (
    active?.identity.sourceHash ??
    active?.events.find((event) => event.sourceHash)?.sourceHash ??
    null
  );
}

export async function measureActivity(
  name: string,
  started: number,
  facts: ReturnType<typeof activityOutcome>,
): Promise<void> {
  await recordMeasurement({
    kind: "activity",
    step: name,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    ...facts,
  });
}
