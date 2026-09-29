import { inputHash, type ExecutionProof, type Inspection } from "@crawl-automation/app";
import {
  ExecutionStatus,
  type CollectionSubmission,
  type DeliveryIssue,
  type DeliveryTarget,
} from "@crawl-automation/v3-contracts";
import { WorkflowNotFoundError, type Client } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { temporal } from "@temporalio/proto";

type HistoryEvent = temporal.api.history.v1.IHistoryEvent;
type Started = temporal.api.history.v1.IWorkflowExecutionStartedEventAttributes;

const CLOSE_EVENT =
  temporal.api.enums.v1.HistoryEventFilterType.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT;

interface Execution {
  namespace: string;
  workflowId: string;
  runId: string;
}

interface CloseCheck {
  event: HistoryEvent | undefined;
  status: ExecutionStatus;
  target: DeliveryTarget;
  requestId: string;
}

async function historyEvent(client: Client, execution: Execution, closeOnly: boolean) {
  const { namespace, workflowId, runId } = execution;
  const response = await client.connection.workflowService.getWorkflowExecutionHistory({
    namespace,
    execution: { workflowId, runId },
    maximumPageSize: 1,
    waitNewEvent: false,
    ...(closeOnly ? { historyEventFilterType: CLOSE_EVENT } : {}),
  });
  return response.history?.events?.[0];
}

function matchesTarget(started: Started, target: DeliveryTarget): boolean {
  return (
    started.workflowType?.name === target.workflowType &&
    started.taskQueue?.name === target.taskQueue &&
    started.input?.payloads?.length === 1
  );
}

function payloadHash(started: Started): string | null {
  const payload = started.input?.payloads?.[0];
  try {
    return payload ? inputHash(defaultPayloadConverter.fromPayload(payload)) : null;
  } catch {
    return null;
  }
}

/** A retry, reset or Continue-As-New run is not proof that the original chain ended. */
function chainContinued(started: Started, runId: string): boolean {
  const retried = (started.attempt ?? 1) > 1;
  const notOriginal =
    started.firstExecutionRunId !== runId || started.originalExecutionRunId !== runId;
  return Boolean(started.continuedExecutionRunId) || retried || notOriginal;
}

/** The execution must be the one this delivery started: same type, queue and input. */
function startIdentity(started: Started | null | undefined, target: DeliveryTarget, runId: string) {
  if (!started || !matchesTarget(started, target)) {
    return "IDENTITY_MISMATCH" as const;
  }
  if (!started.firstExecutionRunId || !started.originalExecutionRunId) {
    return "UNCONFIRMED_TERMINAL" as const;
  }
  const hash = payloadHash(started);
  return hash
    ? { inputHash: hash, continued: chainContinued(started, runId) }
    : ("IDENTITY_MISMATCH" as const);
}

function closeAttributes(event: HistoryEvent, status: ExecutionStatus) {
  const byStatus: Partial<Record<ExecutionStatus, object | null | undefined>> = {
    COMPLETED: event.workflowExecutionCompletedEventAttributes,
    FAILED: event.workflowExecutionFailedEventAttributes,
    CANCELLED: event.workflowExecutionCanceledEventAttributes,
    TERMINATED: event.workflowExecutionTerminatedEventAttributes,
    TIMED_OUT: event.workflowExecutionTimedOutEventAttributes,
  };
  return byStatus[status];
}

/** A completed brand collection must report itself settled for this very request. */
function brandSettled(event: HistoryEvent, requestId: string): boolean {
  const payloads = event.workflowExecutionCompletedEventAttributes?.result?.payloads;
  const payload = payloads?.length === 1 ? payloads[0] : undefined;
  const result = (payload ? defaultPayloadConverter.fromPayload(payload) : null) as {
    codec?: unknown;
    requestId?: unknown;
    settled?: unknown;
  } | null;
  return (
    result?.codec === "brand-collection-settled/1" &&
    result.requestId === requestId &&
    result.settled === true
  );
}

function closeProof(check: CloseCheck) {
  const { event, status, target, requestId } = check;
  const attributes = event ? closeAttributes(event, status) : null;
  if (!event?.eventTime || !event.eventId || !attributes) {
    return "UNCONFIRMED_TERMINAL" as const;
  }
  if (target.workflowType === "BrandCollectionWorkflow" && !brandSettled(event, requestId)) {
    return "UNCONFIRMED_TERMINAL" as const;
  }
  const millis = Number(event.eventTime.seconds) * 1000 + Number(event.eventTime.nanos ?? 0) / 1e6;
  return {
    terminalEventId: event.eventId.toString(),
    closedAt: new Date(millis).toISOString(),
    continued: "newExecutionRunId" in attributes && Boolean(attributes.newExecutionRunId),
  };
}

/** Proves how a closed execution ended; a concurrent reset or new run invalidates the proof. */
interface CloseContext {
  client: Client;
  execution: Execution;
  proof: ExecutionProof;
  target: DeliveryTarget;
}

async function proveClose({ client, execution, proof, target }: CloseContext) {
  const event = await historyEvent(client, execution, true);
  const requestId = execution.workflowId.replace(/^v3-collection-/, "");
  const closed = closeProof({ event, status: proof.status, target, requestId });
  if (typeof closed === "string") {
    return closed;
  }
  const current = await client.workflow.getHandle(execution.workflowId).describe();
  if (current.runId !== execution.runId) {
    return "RUN_CHANGED" as const;
  }
  return { ...proof, ...closed, continued: proof.continued || closed.continued };
}

/** What Temporal shows about one started submission, or the issue that prevents a proof. */
export async function inspectExecution(
  client: Client,
  target: DeliveryTarget,
  submission: CollectionSubmission,
): Promise<Inspection> {
  const description = await client.workflow.getHandle(submission.workflowId).describe();
  const status = ExecutionStatus.parse(description.status.name);
  const execution = {
    namespace: target.namespace,
    workflowId: submission.workflowId,
    runId: description.runId,
  };
  const first = await historyEvent(client, execution, false);
  const identity = startIdentity(
    first?.workflowExecutionStartedEventAttributes,
    target,
    description.runId,
  );
  if (typeof identity === "string") {
    return identity;
  }
  const proof: ExecutionProof = {
    runId: description.runId,
    status,
    terminalEventId: null,
    closedAt: null,
    ...identity,
  };
  if (status === "RUNNING" || status === "CONTINUED_AS_NEW") {
    return proof;
  }
  // Brand children use ABANDON: a failed or cancelled root does not prove its products stopped.
  if (target.workflowType === "BrandCollectionWorkflow" && status !== "COMPLETED") {
    return "UNCONFIRMED_TERMINAL";
  }
  return proveClose({ client, execution, proof, target });
}

export function inspectionIssue(error: unknown): DeliveryIssue {
  const code = (error as { code?: number } | null)?.code;
  return error instanceof WorkflowNotFoundError || code === 5 ? "NOT_FOUND" : "UNAVAILABLE";
}
