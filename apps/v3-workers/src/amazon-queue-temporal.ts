import { isDeepStrictEqual as equal } from "node:util";
import type pg from "pg";
import type { Client } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import type { CollectionSubmission, DeliveryTarget } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { PostgresSubmissions } from "../../v3-api/src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../../v3-api/src/storage/postgres-delivery.js";
import { DeliveryCoordinator } from "../../v3-api/src/delivery/coordinator.js";
import { TemporalGateway } from "../../v3-api/src/delivery/temporal-gateway.js";
import { proofIssue, terminalStatuses } from "../../v3-api/src/delivery/proof-policy.js";
import { ApiError } from "../../v3-api/src/errors.js";
import { scopeForSubmission } from "./brand-pipeline.js";
import type { AmazonLinkBatch } from "./amazon-link-batches.js";
import { QueueAdmissionRejected, type AmazonQueuePorts, type QueueInspection } from "./amazon-queue.js";

type Node = { workflowId: string; runId: string; type: string; status: string; pending: number; events: any[]; parent?: { workflowId: string; runId: string } };
const decode = (payloads: any): any => payloads?.payloads?.length === 1 ? defaultPayloadConverter.fromPayload(payloads.payloads[0]) : null;
function fail(code: string): never { throw Error(`QUEUE.${code}`); }

/** Walk actual Temporal child-start edges, never a prefix search or a guessed list of IDs. */
export async function executionTree(client: Client, workflowId: string, runId: string): Promise<Node[]> {
  const waiting: Array<{ workflowId: string; runId: string; parent?: Node["parent"] }> = [{ workflowId, runId }];
  const nodes: Node[] = [], seen = new Set<string>();
  while (waiting.length) {
    if (seen.size >= 512) fail("TREE_LIMIT");
    const item = waiting.shift()!;
    if (seen.has(item.workflowId)) fail("TREE_CHAIN_CHANGED");
    seen.add(item.workflowId);
    const handle = client.workflow.getHandle(item.workflowId, item.runId), state = await handle.describe();
    if ((await client.workflow.getHandle(item.workflowId).describe()).runId !== item.runId) fail("RUN_CHANGED");
    const history = await handle.fetchHistory(), events = history.events ?? [];
    if (events.length > 20000) fail("HISTORY_LIMIT");
    const start = events[0]?.workflowExecutionStartedEventAttributes;
    if (!start || start.firstExecutionRunId !== item.runId || start.originalExecutionRunId !== item.runId ||
      start.continuedExecutionRunId || (start.attempt ?? 1) !== 1 || state.status.name === "CONTINUED_AS_NEW") fail("TREE_CHAIN_CHANGED");
    if (item.parent && (start.parentWorkflowExecution?.workflowId !== item.parent.workflowId || start.parentWorkflowExecution?.runId !== item.parent.runId)) fail("CHILD_IDENTITY");
    const initiated = new Set(events.flatMap(e => e.startChildWorkflowExecutionInitiatedEventAttributes ? [e.eventId!.toString()] : []));
    for (const e of events) {
      const child = e.childWorkflowExecutionStartedEventAttributes;
      if (child) {
        initiated.delete(child.initiatedEventId!.toString());
        const execution = child.workflowExecution;
        if (!execution?.workflowId || !execution.runId) fail("CHILD_IDENTITY");
        waiting.push({ workflowId: execution!.workflowId!, runId: execution!.runId!, parent: { workflowId: item.workflowId, runId: item.runId } });
      }
      if (e.startChildWorkflowExecutionFailedEventAttributes) initiated.delete(e.startChildWorkflowExecutionFailedEventAttributes.initiatedEventId!.toString());
    }
    // A child Start with an unknown response might already be running. Never infer absence.
    if (initiated.size && terminalStatuses.has(state.status.name)) fail("CHILD_START_UNKNOWN");
    nodes.push({ workflowId: item.workflowId, runId: item.runId, type: state.type, status: state.status.name,
      pending: state.raw.pendingActivities?.length ?? 0, events, ...(item.parent ? { parent: item.parent } : {}) });
  }
  return nodes;
}

/** Only request-mode Amazon can use automatic settlement. Existing browser recoveries
 * still require exact-page evidence and absence checks through their dedicated tools. */
export function verifyStoppedTree(nodes: Node[]) {
  for (const node of nodes) {
    if (!terminalStatuses.has(node.status) || node.pending) fail("TREE_ACTIVE");
    const capture = node.events.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "captureAmazonProduct");
    if (capture.length) {
      if (capture.length !== 1) fail("CAPTURE_IDENTITY");
      const job = decode(capture[0]!.activityTaskScheduledEventAttributes.input);
      const closes = node.events.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "closeAmazonProductPage");
      const results = closes.flatMap(e => node.events.filter(x => x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString() === e.eventId?.toString())
        .map(x => decode(x.activityTaskCompletedEventAttributes.result)));
      // This proof comes from the deployed activity, not the runner's current config.
      if (!job?.sessionId || closes.length !== 1 || !equal(decode(closes[0]!.activityTaskScheduledEventAttributes.input), job) ||
        results.length !== 1 || results[0]?.taskId !== job.sessionId || results[0]?.status !== "not-opened" || results[0]?.targetId !== null) fail("PAGE_CLEANUP_REQUIRED");
    }
  }
}

export class AmazonQueueTemporal implements AmazonQueuePorts {
  readonly submissions: PostgresSubmissions;
  readonly journal: PostgresDelivery;
  readonly gateway: TemporalGateway;
  private readonly delivery: DeliveryCoordinator;
  constructor(readonly db: pg.Pool, readonly resources: pg.Pool, readonly client: Client, target: DeliveryTarget) {
    this.submissions = new PostgresSubmissions(db); this.journal = new PostgresDelivery(db);
    this.gateway = new TemporalGateway(client, target);
    this.delivery = new DeliveryCoordinator(this.submissions, this.journal, this.gateway);
  }
  private bounded<T>(work: () => Promise<T>) { return this.client.connection.withDeadline(Date.now() + 30000, work); }
  private async submission(batch: AmazonLinkBatch): Promise<CollectionSubmission | null> {
    let value;
    try { value = await this.submissions.get(batch.requestId); }
    catch (e) { if (e instanceof ApiError && e.code === "SUBMISSION_NOT_FOUND") return null; throw e; }
    if (!equal(scopeForSubmission({ version: 1, requestId: value.requestId, snapshot: value.snapshot }), batch.scope)) fail("SUBMISSION_CONFLICT");
    return value;
  }
  async submit(batch: AmazonLinkBatch) {
    const receipt = await this.journal.get(batch.requestId);
    if (receipt) return; // No second Start, even after a crash or lost acknowledgement.
    if (!await this.submission(batch)) {
      const revision = /^source-revision-([1-9][0-9]*)$/.exec(batch.scope.scopeVersion);
      if (!revision) throw new QueueAdmissionRejected("QUEUE.SOURCE_REVISION");
      try { await this.submissions.accept(batch.scope.brandId, batch.scope.sourceId, { sourceRevision: Number(revision![1]) }, batch.requestId); }
      catch (e) {
        if (e instanceof ApiError && ["SOURCE_DISABLED", "SOURCE_NOT_FOUND", "REVISION_CONFLICT"].includes(e.code)) throw new QueueAdmissionRejected(`QUEUE.${e.code}`);
        throw e;
      }
    }
    if (!await this.submission(batch)) fail("SUBMISSION_MISSING");
    await this.delivery.reconcile(batch.requestId);
  }
  async audit(requestId: string, timeoutMs = 30000) {
    return this.client.connection.withDeadline(Date.now()+timeoutMs, async () => {
      const submission = await this.submissions.get(requestId), receipt = await this.journal.get(requestId);
      if (!receipt || submission.snapshot.channel !== "amazon") fail("DELIVERY_REQUIRED");
      if (!equal(receipt!.target, this.gateway.target)) fail("TARGET_CHANGED");
      const root = await this.gateway.inspectUnsettledRoot(submission);
      if (proofIssue(receipt!, root)) fail("ROOT_UNVERIFIED");
      if (!terminalStatuses.has(root.status)) {
        // An intake root can still be polling after its product has ended.
        // Surface that product's held permit as cleanup pending, not normal work.
        const held = (await this.resources.query(`SELECT p.request FROM resource_permit p
          JOIN catalog_discovery c ON c.record->>'workflowId'=p.request->>'workflowId'
            OR (c.record->>'workflowId')||'-label'=p.request->>'workflowId'
          WHERE p.released_at IS NULL AND c.catalog_id=$1`, [requestId])).rows;
        for (const {request} of held) {
          const owner = await this.client.workflow.getHandle(request.workflowId,request.runId).describe();
          if (terminalStatuses.has(owner.status.name)) fail("RESOURCE_CLEANUP_PENDING");
        }
        fail("TREE_ACTIVE");
      }
      const nodes = await executionTree(this.client, submission.workflowId, root.runId);
      verifyStoppedTree(nodes);
      const discoveries = (await this.db.query("SELECT record FROM catalog_discovery WHERE catalog_id=$1", [requestId])).rows;
      for (const d of discoveries) {
        const n = nodes.find(n => n.workflowId === d.record.workflowId);
        // A discovered but undispatched product has no execution to close. A dispatch
        // receipt must, however, match an actual descendant from this exact tree.
        const dispatch = (await this.db.query("SELECT execution FROM catalog_dispatch WHERE discovery_id=$1", [d.record.discoveryId])).rows[0];
        if (dispatch && (!n || n.runId !== dispatch.execution.runId)) fail("DISPATCH_UNVERIFIED");
      }
      const ids = nodes.map(n => n.workflowId);
      if ((await this.resources.query("SELECT 1 FROM resource_permit WHERE released_at IS NULL AND request->>'workflowId'=ANY($1)", [ids])).rowCount) fail("RESOURCE_CLEANUP_PENDING");
      for (const node of nodes) {
        const current = await this.client.workflow.getHandle(node.workflowId).describe();
        if (current.runId !== node.runId || current.status.name !== node.status || current.raw.pendingActivities?.length) fail("RUN_CHANGED");
      }
      return { codec: "amazon-queue-settlement/1", requestId, root, heldPermits: 0, pageCleanup: "no-owned-pages",
        trees: nodes.map(({ events, ...n }) => ({ ...n, historySha256: sha256(Buffer.from(JSON.stringify(events))),
          result: decode(events.find(e => e.workflowExecutionCompletedEventAttributes)?.workflowExecutionCompletedEventAttributes?.result) })) };
    });
  }
  async inspect(batch: AmazonLinkBatch): Promise<QueueInspection> {
    const receipt = await this.journal.get(batch.requestId);
    if (!receipt) return { status: "interrupted", proof: { kind: "never-started", requestId: batch.requestId } };
    let proof;
    try { proof = await this.audit(batch.requestId); }
    catch (e) {
      if (e instanceof Error && e.message === "QUEUE.TREE_ACTIVE") return { status: "running" };
      if (e instanceof Error && /^QUEUE\.(RESOURCE_CLEANUP_PENDING|PAGE_CLEANUP_REQUIRED|CHILD_START_UNKNOWN)$/.test(e.message))
        return { status: "cleanup-pending", reason: e.message };
      throw e;
    }
    // The audit is retained in the queue attempt; business Reviews remain append-only.
    const closed = await this.journal.record(batch.requestId, proof.root);
    if (closed.state !== "CLOSED") fail("CLOSURE_UNCONFIRMED");
    const stop = (await this.db.query("SELECT stop_requested_at FROM amazon_queue_attempt WHERE request_id=$1", [batch.requestId])).rows[0];
    const reviews = (await this.db.query("SELECT 1 FROM review_record WHERE record->'observation'->>'requestId'=$1 LIMIT 1", [batch.requestId])).rowCount;
    const products = proof.trees.filter(n => n.type === "AmazonCatalogProductWorkflow");
    const successful = products.length === batch.entries.length && products.every(n => n.status === "COMPLETED" && ["collected", "observed", "skipped"].includes(n.result?.status));
    const status = proof.root.status === "COMPLETED" ? (reviews || !successful ? "review" : "completed") : stop?.stop_requested_at ? "interrupted" : "review";
    return { status, proof };
  }
  async stop(batch: AmazonLinkBatch) {
    await this.db.query("UPDATE amazon_queue_attempt SET stop_requested_at=coalesce(stop_requested_at,clock_timestamp()) WHERE request_id=$1 AND outcome='running'", [batch.requestId]);
    const receipt = await this.journal.get(batch.requestId);
    if (!receipt) return;
    await this.bounded(async () => {
      const submission = await this.submission(batch);
      if (!submission) fail("SUBMISSION_MISSING");
      const root = await this.gateway.inspectUnsettledRoot(submission!);
      if (proofIssue(receipt, root)) fail("ROOT_UNVERIFIED");
      // Cooperative cancellation preserves non-cancellable page/provider cleanup.
      // Traverse again each tick, because a live catalog may have started another child.
      const nodes = await executionTree(this.client, submission!.workflowId, root.runId);
      for (const node of nodes) if (node.status === "RUNNING") await this.client.workflow.getHandle(node.workflowId, node.runId).cancel();
    });
  }
}
