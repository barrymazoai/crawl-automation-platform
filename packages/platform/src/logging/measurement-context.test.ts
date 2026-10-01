import { expect, it, vi } from "vitest";
import { createLogger } from "../logger/create-logger.js";
import { measuredCall, measuredProvider } from "./measured-call.js";
import {
  withMeasurementContext,
  type Measurement,
  type MeasurementIdentity,
} from "./measurement-context.js";

const identity: MeasurementIdentity = {
  runId: "run",
  channel: "gnc",
  operationId: "operation",
  sourceId: "source",
  sourceHash: null,
  workflowId: "workflow",
  temporalRunId: "temporal",
  scanId: null,
};
const log = createLogger({ name: "measurement-test", destination: { write: () => undefined } });

it("keeps missing token usage unknown and counts one call without retry", async () => {
  const events: Measurement[] = [];
  const call = vi.fn(async () => "answer");
  const result = await withMeasurementContext(
    { identity, log, events, record: async () => {} },
    () =>
      measuredCall({ kind: "model-text", step: "text", providerCall: true, cacheHit: false }, call),
  );
  expect(result).toBe("answer");
  expect(call).toHaveBeenCalledOnce();
  expect(events[0]).toMatchObject({
    runId: "run",
    providerCall: true,
    inputTokens: null,
    outputTokens: null,
  });
});

it("a failed metrics write cannot fail completed paid work or hide the original failure", async () => {
  const record = vi.fn(async () => {
    throw new Error("database down");
  });
  const failure = new Error("provider down");
  await withMeasurementContext({ identity, log, events: [], record }, async () => {
    await expect(
      measuredCall({ kind: "capture", step: "fetch" }, async () => "kept"),
    ).resolves.toBe("kept");
    await expect(
      measuredCall({ kind: "capture", step: "fetch" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
  expect(record).toHaveBeenCalledTimes(2);
});

it("adds the same owner to nested helper logs and removes it outside the activity", async () => {
  const lines: Record<string, unknown>[] = [];
  const nested = createLogger({
    name: "nested",
    destination: { write: (line) => lines.push(JSON.parse(line)) },
  });
  await withMeasurementContext({ identity, log, events: [], record: async () => {} }, async () => {
    nested.info("nested preparation");
  });
  nested.info("outside");
  expect(lines[0]).toMatchObject({
    channel: "gnc",
    runId: "run",
    operationId: "operation",
    cacheHit: null,
    providerCall: false,
    outcomeCode: "progress",
    durationMs: expect.any(Number),
  });
  expect(lines[1]).not.toHaveProperty("runId");
});

it.each(["model-text", "model-image", "model-enrichment", "ocr"] as const)(
  "counts %s separately only when the client is invoked",
  async (kind) => {
    const events: Measurement[] = [];
    const client = measuredProvider({ call: vi.fn(async () => "answer") }, "call", kind);
    await withMeasurementContext({ identity, log, events, record: async () => {} }, async () => {
      expect(events).toHaveLength(0);
      expect(await client.call()).toBe("answer");
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind, providerCall: true, cacheHit: false });
  },
);
