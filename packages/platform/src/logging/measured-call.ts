import { errorCodeOf } from "../errors/error-code.js";
import { isAppError } from "../errors/app-error.js";
import { pipelineErrors } from "../errors/pipeline-errors.js";
import { recordMeasurement, type Measurement } from "./measurement-context.js";

export type CallMeasurement = Pick<Measurement, "kind" | "step"> & Partial<Measurement>;

/** Decorates a single call, without retrying it or changing its result. */
export async function measuredCall<Result>(
  facts: CallMeasurement,
  call: () => Promise<Result>,
  completed?: (result: Result) => Partial<Measurement>,
): Promise<Result> {
  const started = Date.now();
  const timing = { startedAt: new Date(started).toISOString() };
  try {
    const result = await call();
    await recordMeasurement({
      ...facts,
      ...timing,
      durationMs: Date.now() - started,
      outcomeCode: "completed",
      ...completed?.(result),
    });
    return result;
  } catch (error) {
    await recordMeasurement({
      ...facts,
      ...timing,
      durationMs: Date.now() - started,
      outcomeCode: errorCodeOf(error) ?? pipelineErrors.code("PIPELINE.ACTIVITY_UNRESOLVED"),
      ...failureFacts(error),
    });
    throw error;
  }
}

function failureFacts(error: unknown): Partial<Measurement> {
  if (!isAppError(error)) {
    return {};
  }
  const { creditCost, executionFact } = error.details;
  if (typeof creditCost === "number" && Number.isFinite(creditCost) && creditCost >= 0) {
    return { creditCost, providerCall: true, cacheHit: false };
  }
  return executionFact === "not_executed" ? { providerCall: false } : {};
}

/** Composition-root decorator. Internal calls through `this` also use the decorated method. */
export function measuredMethod<Target extends object>(
  target: Target,
  method: keyof Target,
  facts: CallMeasurement,
): Target {
  return new Proxy(target, {
    get(instance, key, receiver) {
      const value: unknown = Reflect.get(instance, key, receiver);
      if (key !== method || typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) =>
        measuredCall(facts, () => Reflect.apply(value, receiver, args) as Promise<unknown>);
    },
  });
}

/** Client calls only; internal model requests/tokens remain unknown unless the client exposes them. */
export function measuredProvider<Target extends object>(
  target: Target,
  method: keyof Target,
  kind: "model-text" | "model-image" | "model-enrichment" | "ocr",
): Target {
  return measuredMethod(target, method, { kind, step: kind, providerCall: true, cacheHit: false });
}
