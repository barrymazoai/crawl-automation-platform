import { randomUUID } from "node:crypto";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, type WorkerOptions } from "@temporalio/worker";
import { expect } from "vitest";
import {
  labelNoSourceMarker,
  labelPageVerdictMarker,
  pipelineMarkers,
  stopProofMarker,
  type PatchMarker,
  type ReplayBundle,
} from "./bundles.js";

type Handle = Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>;
export type History = Awaited<ReturnType<Handle["fetchHistory"]>>;

interface Recording {
  environment: TestWorkflowEnvironment;
  bundle: ReplayBundle;
  queue: string;
  workflow: string;
  workflowId?: string;
  input: unknown;
  activities: NonNullable<WorkerOptions["activities"]>;
  afterStart?: (handle: Handle) => Promise<void>;
  fails?: boolean;
}

/** No JSON histories, provider calls or persistent test data: fetch directly into memory. */
export async function recordHistory(recording: Recording) {
  const worker = await Worker.create({
    connection: recording.environment.nativeConnection,
    workflowBundle: recording.bundle,
    taskQueue: recording.queue,
    activities: recording.activities,
  });
  return worker.runUntil(async () => {
    const workflowId = recording.workflowId ?? randomUUID();
    const handle = await recording.environment.client.workflow.start(recording.workflow, {
      taskQueue: recording.queue,
      workflowId,
      args: [recording.input],
    });
    await recording.afterStart?.(handle);
    let result: unknown;
    if (recording.fails) {
      await expect(handle.result()).rejects.toThrow();
    } else {
      result = await handle.result();
    }
    const history = await handle.fetchHistory();
    const terminal = history.events?.at(-1);
    expect(
      recording.fails
        ? terminal?.workflowExecutionFailedEventAttributes
        : terminal?.workflowExecutionCompletedEventAttributes,
    ).toBeTruthy();
    // Temporal histories omit the workflow ID; replay needs it for derived child IDs.
    return { history, result, workflowId };
  });
}

export function expectMarkers(history: History, expected: readonly PatchMarker[]) {
  const markers = [
    ...pipelineMarkers,
    labelNoSourceMarker,
    labelPageVerdictMarker,
    "formula-family-capture-v1",
    "brand-listing-gap-v1",
    "browser-scan-permit-v1",
    "family-formula-outcomes-v1",
    "brand-listing-cooldown-v1",
    stopProofMarker,
    "browser-resource-outage-wait-v1",
    "browser-resource-routing-v1",
  ] as const;
  const found = markers.filter((marker) => hasMarker(history, marker));
  expect(found).toEqual(markers.filter((marker) => expected.includes(marker)));
}

/** Patch names are stored as encoded payloads, so a plain text search of the history never finds them. */
export function hasMarker(history: History, marker: PatchMarker): boolean {
  return (history.events ?? []).some((event) =>
    Object.values(event.markerRecordedEventAttributes?.details ?? {}).some((values) =>
      values.payloads?.some((value) =>
        Buffer.from(value.data ?? [])
          .toString()
          .includes(`"${marker}"`),
      ),
    ),
  );
}

export function scheduledActivities(history: History): string[] {
  return (history.events ?? []).flatMap((event) => {
    const name = event.activityTaskScheduledEventAttributes?.activityType?.name;
    return name ? [name] : [];
  });
}

export function childCommands(history: History) {
  const events = history.events ?? [];
  return {
    types: events.flatMap((event) => {
      const name = event.startChildWorkflowExecutionInitiatedEventAttributes?.workflowType?.name;
      return name ? [name] : [];
    }),
    signals: events.flatMap((event) => {
      const name = event.signalExternalWorkflowExecutionInitiatedEventAttributes?.signalName;
      return name ? [name] : [];
    }),
  };
}

export function heartbeatSeconds(history: History, activity: string): number[] {
  return (history.events ?? []).flatMap((event) => {
    const scheduled = event.activityTaskScheduledEventAttributes;
    return scheduled?.activityType?.name === activity
      ? [Number(scheduled.heartbeatTimeout?.seconds ?? 0)]
      : [];
  });
}
