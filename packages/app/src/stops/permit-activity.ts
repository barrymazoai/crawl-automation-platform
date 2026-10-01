import {
  errorCodeOf,
  isAppError,
  withPermitExecution,
  type PermitExecutionLedger,
  type PermitOwner,
} from "@crawl-automation/platform";

export interface PermitActivityLedger extends PermitExecutionLedger {
  begin(owner: PermitOwner): Promise<boolean>;
  finish(owner: PermitOwner, failure: Record<string, unknown> | null): Promise<void>;
}

let ledger: PermitActivityLedger | undefined;

/** Installed once by the worker composition root; no provider has database dependencies. */
export function configurePermitActivityLedger(value: PermitActivityLedger): void {
  ledger = value;
}

/** Activity IDs are exact permit IDs; old gate histories can also attach executor receipts. */
export async function runWithPermitActivity<Result>(
  info: { activityId: string; workflowExecution: { workflowId: string; runId: string } },
  work: () => Promise<Result>,
): Promise<Result> {
  const store = ledger;
  const owner = { permitId: info.activityId, ...info.workflowExecution };
  if (!store || !owner.permitId.startsWith("permit-") || !(await store.begin(owner))) {
    return work();
  }
  return withPermitExecution({ owner, ledger: store }, async () => {
    let failure: Record<string, unknown> | null = null;
    try {
      return await work();
    } catch (error) {
      failure = {
        code: errorCodeOf(error),
        message: String(error),
        details: isAppError(error) ? error.details : null,
      };
      throw error;
    } finally {
      await store.finish(owner, failure);
    }
  });
}
