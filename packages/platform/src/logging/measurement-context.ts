import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

/** Opaque correlation fields supplied by the host; the platform never resolves business identities. */
export interface MeasurementIdentity {
  channel: string | null;
  runId: string | null;
  operationId: string | null;
  sourceId: string | null;
  sourceHash: string | null;
  workflowId: string | null;
  temporalRunId: string | null;
  scanId: string | null;
}

export type MeasurementKind =
  | "activity"
  | "capture"
  | "brand-request"
  | "model-text"
  | "model-image"
  | "model-enrichment"
  | "ocr"
  | "preparation";

export interface Measurement extends MeasurementIdentity {
  eventId: string;
  kind: MeasurementKind;
  step: string;
  startedAt: string;
  durationMs: number;
  outcomeCode: string;
  cacheHit: boolean | null;
  providerCall: boolean;
  creditCost: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface MeasurementContext {
  identity: MeasurementIdentity;
  log: Logger;
  record(event: Measurement): Promise<void>;
  events: Measurement[];
  startedAtMs?: number;
}

const context = new AsyncLocalStorage<MeasurementContext>();
export const currentMeasurement = () => context.getStore();

export function withMeasurementContext<Result>(
  value: MeasurementContext,
  work: () => Promise<Result>,
): Promise<Result> {
  return context.run({ ...value, startedAtMs: value.startedAtMs ?? Date.now() }, work);
}

/** Pino mixin for logs emitted by nested storage/processing helpers using their own logger. */
export function measurementLogFields(): Record<string, unknown> {
  const active = context.getStore();
  return active
    ? {
        ...active.identity,
        outcomeCode: "progress",
        cacheHit: null,
        providerCall: false,
        durationMs: Date.now() - (active.startedAtMs ?? Date.now()),
      }
    : {};
}

/** Recording failure is visible, but must never turn completed paid work into a failed business operation. */
export async function recordMeasurement(
  facts: Pick<Measurement, "kind" | "step" | "startedAt" | "durationMs" | "outcomeCode"> &
    Partial<Measurement>,
): Promise<void> {
  const active = context.getStore();
  if (!active) {
    return;
  }
  const event: Measurement = {
    ...active.identity,
    eventId: randomUUID(),
    cacheHit: null,
    providerCall: false,
    creditCost: null,
    inputTokens: null,
    outputTokens: null,
    ...facts,
  };
  active.events.push(event);
  active.log.info(event, "usage measured");
  try {
    await active.record(event);
  } catch (error) {
    active.log.error(
      { ...event, err: error, measurementPersisted: false },
      "usage persistence failed",
    );
  }
}
