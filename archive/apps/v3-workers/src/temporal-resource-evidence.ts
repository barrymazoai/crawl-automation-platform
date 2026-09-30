import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Client } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { z } from "zod";
import { ArtifactRefSchema, ResourceRequestSchema, ResourceDecisionSchema, ResourceRecoveryProofSchema,
  OcrActivityOutcomeSchema, TextActivityOutcomeSchema, GncAcquireOutcomeSchema, GncProductPrepareOutcomeSchema,
  GncLabelPlanOutcomeSchema, FileAcquireOutcomeSchema, CatalogPageSchema, ExecutionIdSchema, ObjectKeySchema,
  type ResourceRequest } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { canonical, type RecoveryEvidence } from "../../../packages/v3-product/src/resource-recovery.js";

type Event = { eventId?: unknown; [key: string]: any };
export type ClosedRun = { workflowId: string; runId: string; type: string; status: string; history: { events?: Event[] | null } };
export type Effect = { activityId: string; activityType: string; scheduledEventId: number; completedEventId: number; input: unknown; output: unknown };
const number = (v: unknown) => { const n = Number(String(v)); if (!Number.isSafeInteger(n) || n < 1) throw Error("RESOURCE_RECOVERY.HISTORY_INVALID"); return n; };
function payloads(raw: any) {
  if (raw?.payloads?.length !== 1) throw Error("RESOURCE_RECOVERY.PAYLOAD_UNSUPPORTED");
  const p = raw.payloads[0];
  if (!(p.data instanceof Uint8Array) || Buffer.from(p.metadata?.encoding ?? []).toString() !== "json/plain") throw Error("RESOURCE_RECOVERY.PAYLOAD_UNSUPPORTED");
  return JSON.parse(Buffer.from(p.data).toString("utf8"));
}
const quarantine = (code: string): RecoveryEvidence => ({ status: "quarantined", code: `RESOURCE_RECOVERY.${code}` });
/** This planner intentionally rejects ambiguous interleaving or partial phases instead of guessing a resource owner. */
export function planRelease(request: ResourceRequest, run: ClosedRun, trustedTypes: readonly string[]) {
  if (run.workflowId !== request.workflowId || run.runId !== request.runId) throw Error("RESOURCE_RECOVERY.IDENTITY_CONFLICT");
  if (run.status === "RUNNING") return { reason: "OWNER_RUNNING" } as const;
  if (!["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(run.status)) return { reason: "OWNER_UNCONFIRMED" } as const;
  if (!trustedTypes.includes(run.type)) return { reason: "WORKFLOW_UNSUPPORTED" } as const;
  const events = run.history.events ?? [];
  if (events.length < 3 || events.length > 100000) return { reason: "HISTORY_INCOMPLETE" } as const;
  let last = 0;
  for (const e of events) { const id = number(e.eventId); if (id !== last + 1) return { reason: "HISTORY_INCOMPLETE" } as const; last = id; }
  const terminal = events.at(-1)!;
  const terminalKey: Record<string, string> = { COMPLETED: "workflowExecutionCompletedEventAttributes", FAILED: "workflowExecutionFailedEventAttributes",
    CANCELLED: "workflowExecutionCanceledEventAttributes", TERMINATED: "workflowExecutionTerminatedEventAttributes", TIMED_OUT: "workflowExecutionTimedOutEventAttributes" };
  if (!terminal[terminalKey[run.status]!]) return { reason: "HISTORY_INCOMPLETE" } as const;
  const scheduled = events.filter(e => e.activityTaskScheduledEventAttributes);
  const releases = scheduled.filter(e => e.activityTaskScheduledEventAttributes.activityType?.name === "releaseResources" &&
    isDeepStrictEqual(ResourceRequestSchema.parse(payloads(e.activityTaskScheduledEventAttributes.input)), request));
  if (releases.length !== 1) return { reason: "NO_UNIQUE_RELEASE_INTENT" } as const;
  const release = releases[0]!, releaseId = number(release.eventId);
  let grantId = 0;
  for (const e of scheduled.filter(e => e.activityTaskScheduledEventAttributes.activityType?.name === "reserveResources")) {
    if (!isDeepStrictEqual(ResourceRequestSchema.parse(payloads(e.activityTaskScheduledEventAttributes.input)), request)) continue;
    const completed = events.find(c => c.activityTaskCompletedEventAttributes && number(c.activityTaskCompletedEventAttributes.scheduledEventId) === number(e.eventId));
    if (!completed) continue;
    const decision = ResourceDecisionSchema.parse(payloads(completed.activityTaskCompletedEventAttributes.result));
    if (decision.permitId !== request.permitId) throw Error("RESOURCE_RECOVERY.IDENTITY_CONFLICT");
    if (decision.status === "granted" && number(completed.eventId) < releaseId) grantId = number(completed.eventId);
  }
  if (!grantId) return { reason: "GRANT_UNCONFIRMED" } as const;
  const effects: Effect[] = [];
  for (const e of scheduled.filter(e => number(e.eventId) > grantId && number(e.eventId) < releaseId)) {
    const a = e.activityTaskScheduledEventAttributes;
    if (["reserveResources", "releaseResources"].includes(a.activityType?.name)) continue;
    const c = events.find(c => c.activityTaskCompletedEventAttributes && number(c.activityTaskCompletedEventAttributes.scheduledEventId) === number(e.eventId) && number(c.eventId) < releaseId);
    if (!c) return { reason: "EXECUTION_UNCONFIRMED" } as const;
    // A retried external Activity might leave a previous timed-out attempt alive.
    const started = events.find(s => s.activityTaskStartedEventAttributes && number(s.activityTaskStartedEventAttributes.scheduledEventId) === number(e.eventId));
    if (!started || (started.activityTaskStartedEventAttributes.attempt ?? 1) !== 1) return { reason: "EXECUTION_UNCONFIRMED" } as const;
    effects.push({ activityId: a.activityId, activityType: a.activityType.name, scheduledEventId: number(e.eventId), completedEventId: number(c.eventId),
      input: payloads(a.input), output: payloads(c.activityTaskCompletedEventAttributes.result) });
  }
  if (!effects.length) return { reason: "EXECUTION_UNCONFIRMED" } as const;
  return { grantId, releaseId, terminalId: last, effects };
}

const visionReceipt = z.strictObject({ status: z.literal("registered"), candidateStatus: z.enum(["candidate", "partial"]), operationId: ExecutionIdSchema, evidenceKey: ObjectKeySchema });
export async function verifySuccessfulEffect(effect: Effect, store: ObjectStore, signal: AbortSignal) {
  const input: any = effect.input; let output: any;
  switch (effect.activityType) {
    case "ocrFile": output = OcrActivityOutcomeSchema.parse(effect.output); break;
    case "interpretText": output = TextActivityOutcomeSchema.parse(effect.output); break;
    case "interpretImage": output = visionReceipt.parse(effect.output); break;
    case "captureGncProduct": output = GncAcquireOutcomeSchema.parse(effect.output); break;
    case "prepareGncProduct": output = GncProductPrepareOutcomeSchema.parse(effect.output); break;
    case "loadGncLabelPlan": output = GncLabelPlanOutcomeSchema.parse(effect.output); break;
    case "acquireSourceFile": output = FileAcquireOutcomeSchema.parse(effect.output); break;
    case "readCatalogPage": output = CatalogPageSchema.parse(effect.output); break;
    default: throw Error("RESOURCE_RECOVERY.EFFECT_UNSUPPORTED");
  }
  if (output.status === "review") throw Error("RESOURCE_RECOVERY.REVIEW_PRESERVED");
  const operationId = input.operationId ?? input.input?.operationId ?? input.capture?.operationId;
  if (output.operationId && output.operationId !== operationId) throw Error("RESOURCE_RECOVERY.IDENTITY_CONFLICT");
  if (output.input && !isDeepStrictEqual(output.input, effect.input)) throw Error("RESOURCE_RECOVERY.IDENTITY_CONFLICT");
  // Vision receipt has only a completion key; its typed reader is used by the caller, not a guessed successful flag.
  if (effect.activityType === "interpretImage") throw Error("RESOURCE_RECOVERY.VISION_READER_REQUIRED");
  const refs = new Map<string, z.infer<typeof ArtifactRefSchema>>();
  const visit = (v: any) => { if (!v || typeof v !== "object") return;
    const p = ArtifactRefSchema.safeParse(v); if (p.success) {
      const old = refs.get(p.data.objectKey); if (old && !isDeepStrictEqual(old, p.data)) throw Error("RESOURCE_RECOVERY.EVIDENCE_CONFLICT"); refs.set(p.data.objectKey, p.data);
    }
    Object.values(v).forEach(visit);
  };
  visit(output); if (!refs.size) throw Error("RESOURCE_RECOVERY.EVIDENCE_MISSING");
  for (const r of refs.values()) { const bytes = await store.read(r.objectKey, r.byteSize, signal); if (!bytes) throw Error("RESOURCE_RECOVERY.EVIDENCE_MISSING"); verifyBytes(r, bytes, r.byteSize); }
}

export class TemporalResourceEvidence {
  constructor(private readonly deps: { client: Client; namespace: string; bundlePath: string; bundleSha256: string;
    store: ObjectStore; verifyEffect?: (effect: Effect, signal: AbortSignal) => Promise<void>;
    trustedTypes?: readonly string[] }) {}
  async inspect(request: ResourceRequest): Promise<RecoveryEvidence> {
    try {
      const handle = this.deps.client.workflow.getHandle(request.workflowId, request.runId), d = await handle.describe();
      if (d.runId !== request.runId) return quarantine("IDENTITY_CONFLICT");
      if (d.status.name === "RUNNING") return quarantine("OWNER_RUNNING");
      const history = await handle.fetchHistory();
      const plan = planRelease(request, { workflowId: request.workflowId, runId: d.runId, type: d.type, status: d.status.name, history },
        this.deps.trustedTypes ?? ["CatalogWorkflow", "GncLeasedProductWorkflow", "GncStreamingLabelWorkflow"]);
      if ("reason" in plan) return quarantine(plan.reason!);
      const bundle = await readFile(this.deps.bundlePath);
      if (sha256(bundle) !== this.deps.bundleSha256) return quarantine("BUILD_MISMATCH");
      // Replay is local and never executes Activities or resumes the original Workflow.
      await Worker.runReplayHistory({ workflowBundle: { code: bundle.toString("utf8") } }, history, request.workflowId);
      const signal = AbortSignal.timeout(120000);
      for (const e of plan.effects) await (this.deps.verifyEffect ? this.deps.verifyEffect(e, signal) : verifySuccessfulEffect(e, this.deps.store, signal));
      const historyBytes = Buffer.from(canonical(JSON.parse(JSON.stringify(history))));
      if (historyBytes.length > 16777216) return quarantine("HISTORY_LIMIT");
      return { status: "verified", historyBytes, proof: ResourceRecoveryProofSchema.parse({ codec: "resource-release-proof/1", namespace: this.deps.namespace, request,
        historySha256: sha256(historyBytes), workflowBundleSha256: this.deps.bundleSha256, grantEventId: plan.grantId,
        releaseIntentEventId: plan.releaseId, terminalEventId: plan.terminalId,
        verifiedEffects: plan.effects.map(({ input: _i, output: _o, ...e }) => e) }) };
    } catch (error) {
      const code = error instanceof Error && /^RESOURCE_RECOVERY\.[A-Z_]+$/.test(error.message) ? error.message.slice("RESOURCE_RECOVERY.".length) : "EVIDENCE_UNVERIFIED";
      return quarantine(code);
    }
  }
}
