import { AsyncLocalStorage } from "node:async_hooks";

export interface PermitOwner {
  permitId: string;
  workflowId: string;
  runId: string;
}

export type PermitExecutionIdentity = {
  executionId: string;
  metadata?: Record<string, unknown>;
} & (
  | { kind: "ocr"; endpoint: string }
  | { kind: "browser"; taskSpaceId: number }
  | { kind: "browser-round"; taskSpaceId: number }
  | { kind: "codex"; pid: number; host: string; startedAt: string }
);

export interface PermitExecutionLedger {
  record(owner: PermitOwner, identity: PermitExecutionIdentity): Promise<void>;
  prove(
    owner: PermitOwner,
    identity: PermitExecutionIdentity,
    proof: Record<string, unknown>,
  ): Promise<void>;
}

const executions = new AsyncLocalStorage<{
  owner: PermitOwner;
  ledger: PermitExecutionLedger;
}>();

/** Propagates the permit through provider calls, including their awaited cleanup. */
export function withPermitExecution<Result>(
  context: { owner: PermitOwner; ledger: PermitExecutionLedger },
  work: () => Promise<Result>,
): Promise<Result> {
  return executions.run(context, work);
}

export function currentPermitExecution(): PermitOwner | undefined {
  return executions.getStore()?.owner;
}

/** Must finish before starting remote work; a failed journal write prevents execution. */
export async function recordPermitExecution(identity: PermitExecutionIdentity): Promise<void> {
  const context = executions.getStore();
  await context?.ledger.record(context.owner, identity);
}

/** Only an observed terminal provider state or exact-target absence is a stop receipt. */
export async function provePermitExecutionStopped(
  identity: PermitExecutionIdentity,
  proof: Record<string, unknown>,
): Promise<void> {
  const context = executions.getStore();
  await context?.ledger.prove(context.owner, identity, proof);
}
