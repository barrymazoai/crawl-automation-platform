import { allHandlersFinished, ApplicationFailure, CancellationScope, condition, continueAsNew,
  defineUpdate, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import { CatalogWorkflowInputSchema, DtcBrowserControlSchema, DtcNodeSessionSchema,
  DtcNodeReportSchema, type DtcNodeSession } from '@crawl-automation/v3-contracts';
import { CatalogWorkflow } from './catalog-workflow.js';
import { DtcCatalogProductWorkflow } from './dtc-catalog-workflow.js';

const controlOptions = (taskQueue: string) => ({ taskQueue, startToCloseTimeout: '10 seconds' as const,
  scheduleToCloseTimeout: '20 seconds' as const, retry: { maximumAttempts: 1 } });
function installBrowserControl(queue: string) {
  const activity = proxyActivities<{ dtcBrowserControl(raw: unknown): Promise<unknown> }>(controlOptions(queue));
  setHandler(defineUpdate<unknown, [unknown]>('dtcBrowserControl'), raw =>
    CancellationScope.nonCancellable(() => activity.dtcBrowserControl(DtcBrowserControlSchema.parse(raw))));
}
export async function DtcCatalogWorkflow(raw: unknown): Promise<unknown> {
  const input = CatalogWorkflowInputSchema.parse(raw);
  if (input.scope.channel !== 'dtc' || input.productWorkflow !== 'DtcCatalogProductV2Workflow')
    throw ApplicationFailure.nonRetryable('Invalid DTC route', 'DTC.CONTROL_ROUTE');
  installBrowserControl(input.queues.ledger);
  try { return await CatalogWorkflow(input); }
  finally { await CancellationScope.nonCancellable(() => condition(allHandlersFinished)); }
}
export async function DtcCatalogProductV2Workflow(raw: unknown): Promise<unknown> {
  installBrowserControl(workflowInfo().taskQueue);
  try { return await DtcCatalogProductWorkflow(raw); }
  finally { await CancellationScope.nonCancellable(() => condition(allHandlersFinished)); }
}
export async function DtcNodePreflightWorkflow(raw: { nodeId: string; controlQueue: string }): Promise<unknown> {
  return proxyActivities<{ dtcNodeControl(raw: unknown): Promise<unknown> }>(controlOptions(raw.controlQueue))
    .dtcNodeControl({ action: 'preflight', nodeId: raw.nodeId });
}
// One session per Windows supervisor, with bounded history. The Mini owns all
// resource writes; Windows only reports observations through Temporal updates.
export async function DtcNodeSessionWorkflow(raw: unknown): Promise<unknown> {
  const session = DtcNodeSessionSchema.parse(raw);
  const call = proxyActivities<{ dtcNodeControl(raw: unknown): Promise<unknown> }>(controlOptions(session.controlQueue)).dtcNodeControl;
  let ready = false, stopped = false, busy = false, sequence = session.sequence, updates = 0;
  const serial = async <T>(run: () => Promise<T>): Promise<T> => {
    await condition(() => ready && !busy); busy = true;
    try { return await run(); } finally { busy = false; }
  };
  setHandler(defineUpdate<unknown, [unknown]>('dtcNodeHealth'), raw => serial(async () => {
    const report = DtcNodeReportSchema.parse(raw);
    if (stopped || report.sessionId !== session.sessionId || report.sequence <= sequence)
      throw ApplicationFailure.nonRetryable('Stale node report', 'DTC.NODE_SESSION_CONFLICT');
    const result = await call({ action: 'health', session, report }); sequence = report.sequence; updates++;
    return result;
  }));
  setHandler(defineUpdate<unknown, [string]>('dtcNodeStop'), id => serial(async () => {
    if (id !== session.sessionId) throw ApplicationFailure.nonRetryable('Foreign node session', 'DTC.NODE_SESSION_CONFLICT');
    const result = await call({ action: 'close', session }); stopped = true; return result;
  }));
  if (!session.resumed) await call({ action: 'open', session });
  ready = true;
  await condition(() => stopped || updates >= 1000);
  await condition(allHandlersFinished);
  if (stopped) return { status: 'stopped', sessionId: session.sessionId };
  return continueAsNew<typeof DtcNodeSessionWorkflow>({ ...session, sequence, resumed: true } satisfies DtcNodeSession);
}
