import { proxyActivities, workflowInfo, CancellationScope, isCancellation, sleep, startChild, ParentClosePolicy,
  WorkflowIdReusePolicy, ActivityCancellationType, continueAsNew, ApplicationFailure } from '@temporalio/workflow';
import { z } from 'zod';
import { CallSchema, CONTROL_QUEUE, BROWSER_QUEUE, workflowId, baseOutcome, type Call, type Seed, type Outcome } from './contracts.js';

export interface ControlActivities {
  claim(x: Call): Promise<{ terminal: Outcome | null }>;
  prepareSeed(x: Call): Promise<{ status: 'waiting' } | { status: 'ready'; seed: Seed }>;
  releaseSeed(x: Call): Promise<void>;
  finish(x: Outcome): Promise<Outcome>;
  readResult(x: Call): Promise<Outcome | null>;
  nextCandidates(x: { campaignId: string; limit: number; selection: string[] }): Promise<string[]>;
  campaignStatus(x: { campaignId: string }): Promise<unknown>;
}
export interface BrowserActivities { discoverEntry(x: Seed): Promise<Outcome>; recoverEntry(x: Call): Promise<Outcome['cleanup']>; }
const control = () => proxyActivities<ControlActivities>({ taskQueue: CONTROL_QUEUE, startToCloseTimeout: '110 seconds',
  scheduleToCloseTimeout: '3 minutes', heartbeatTimeout: '15 seconds', retry: { maximumAttempts: 1 }, cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED });
const browser = () => proxyActivities<BrowserActivities>({ taskQueue: BROWSER_QUEUE, startToCloseTimeout: '240 seconds',
  scheduleToCloseTimeout: '5 minutes', heartbeatTimeout: '15 seconds', retry: { maximumAttempts: 1 }, cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED });
const errorCode = (error: unknown): string => {
  let e: any = error;
  for (let i = 0; e && i < 8; i++, e = e.cause) {
    for (const text of [e.type, e.message]) if (typeof text === 'string' && /^(BRAND_ENTRY|AMAZON|ARTIFACT|RESOURCE|NETWORK|SCRAPERAPI)\.[A-Z_]+$/.test(text)) return text;
  }
  return 'BRAND_ENTRY.EXECUTION_UNRESOLVED';
};
export async function AmazonBrandEntryWorkflow(raw: unknown): Promise<Outcome> {
  const x = CallSchema.parse(raw), a = control(), b = browser();
  if (workflowInfo().workflowId !== workflowId(x)) throw ApplicationFailure.nonRetryable('Identity mismatch', 'BRAND_ENTRY.OWNER');
  let outcome = baseOutcome(x, 'failed', 'BRAND_ENTRY.EXECUTION_UNRESOLVED'), browserStarted = false, claimSucceeded = false;
  try {
    const claimed = await a.claim(x); claimSucceeded = true;
    if (claimed.terminal) return claimed.terminal;
    let seed: Seed | null = null;
    for (let poll = 0; poll < 90; poll++) {
      const prepared = await a.prepareSeed(x);
      if (prepared.status === 'ready') { seed = prepared.seed; break; }
      await sleep('10 seconds');
    }
    if (!seed) throw ApplicationFailure.nonRetryable('Capacity unavailable', 'BRAND_ENTRY.CAPACITY_WAIT_LIMIT');
    outcome.seed = seed;
    browserStarted = true;
    outcome = await b.discoverEntry(seed);
  } catch (error) {
    outcome.state = isCancellation(error) ? 'cancelled' : 'failed';
    outcome.code = isCancellation(error) ? 'BRAND_ENTRY.CANCELLED' : errorCode(error);
    await CancellationScope.nonCancellable(async () => {
      if (browserStarted) {
        try { outcome.cleanup = await b.recoverEntry(x); }
        catch { outcome.cleanup = { status: 'pending', targetIds: [], checkedAt: new Date().toISOString() }; }
      }
    });
  } finally {
    if (claimSucceeded) await CancellationScope.nonCancellable(() => a.releaseSeed(x));
  }
  if (!claimSucceeded) throw ApplicationFailure.nonRetryable('Claim unresolved; inspect ledger', outcome.code);
  return CancellationScope.nonCancellable(async () => {
    try { return await a.finish(outcome); }
    catch (error) {
      // A lost receipt is checked once; never repeat publication or the browser phase.
      const committed = await a.readResult(x);
      if (committed) return committed;
      throw error;
    }
  });
}

export const CampaignInput = z.strictObject({ campaignId: z.uuid(), limit: z.number().int().min(1).max(10000),
  selection: z.array(z.uuid()).max(10000).default([]), processed: z.number().int().nonnegative().default(0) });
export async function AmazonBrandEntryCampaignWorkflow(raw: unknown): Promise<unknown> {
  const input = CampaignInput.parse(raw), a = control();
  let done = 0;
  while (done < input.limit) {
    const ids = await a.nextCandidates({ campaignId: input.campaignId, selection: input.selection, limit: 1 });
    if (!ids.length) break;
    const call = { campaignId: input.campaignId, candidateId: ids[0]! };
    const child = await startChild(AmazonBrandEntryWorkflow, { workflowId: workflowId(call), taskQueue: CONTROL_QUEUE,
      args: [call], parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL, workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      retry: { maximumAttempts: 1 } });
    const result = await child.result(); done++;
    if (result.cleanup.status === 'pending') throw ApplicationFailure.nonRetryable('Browser executor quarantined; inspect exact targets', 'BRAND_ENTRY.CLEANUP_PENDING');
    if (done === 20 && done < input.limit) return continueAsNew<typeof AmazonBrandEntryCampaignWorkflow>({ ...input, limit: input.limit - done, processed: input.processed + done });
  }
  return { processed: input.processed + done, counts: await a.campaignStatus({ campaignId: input.campaignId }) };
}
