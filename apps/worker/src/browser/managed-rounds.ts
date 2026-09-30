import {
  EGO_MARKER,
  EgoRunner,
  egoErrors,
  isAppError,
  type EgoPages,
  type EgoSettings,
} from "@crawl-automation/platform";

/** Only reads the tab inventory. A close receipt can precede disappearance from that inventory. */
export function targetAbsenceScript(taskSpaceId: number, targetId: string): string {
  return `
const emit = value => console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify(value));
const task = await taskSpace(${JSON.stringify(taskSpaceId)});
let closed = false;
for (let attempt = 0; attempt < 4; attempt++) {
  if (task.ownership === 'user') { emit({ kind: 'stop', reason: 'user-control' }); return; }
  closed = !(await task.tabs()).some(tab => tab.targetId === ${JSON.stringify(targetId)});
  if (closed) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
emit({ kind: 'result', targetId: ${JSON.stringify(targetId)}, closed, failure: null, value: null });`;
}

/** Injected only for offline tests; production verification uses Ego's own task-space SDK. */
export type VerifyTarget = (targetId: string, signal: AbortSignal) => Promise<boolean>;

export function egoTargetVerifier(settings: EgoSettings): VerifyTarget {
  const runner = new EgoRunner(settings);
  return async (targetId, signal) => {
    try {
      await runner.run(targetAbsenceScript(settings.taskSpaceId, targetId), signal);
      return true;
    } catch (error) {
      if (isAppError(error) && error.code === "BROWSER.PAGE_CLEANUP_PENDING") {
        return false;
      }
      throw error;
    }
  };
}

function pendingTargets(error: unknown): string[] {
  if (!isAppError(error) || error.code !== "BROWSER.PAGE_CLEANUP_PENDING") {
    return [];
  }
  const { targetId, opened } = error.details;
  const values = [targetId, ...(Array.isArray(opened) ? opened : [])];
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

/**
 * EgoPages already closes on success/failure. Recover exact reported targets if its runtime was
 * cancelled or killed, using a fresh bounded signal after the executor has stopped. Never take
 * back a user-owned space, and never report cleanup complete without observing target absence.
 */
export class ManagedBrowserRounds {
  constructor(
    private readonly browser: Pick<EgoPages, "round" | "closeTarget">,
    private readonly absent: VerifyTarget,
  ) {}

  async round(body: string, params: object, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    try {
      const value = await this.browser.round(body, params, signal);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      const targets = pendingTargets(error);
      if (!targets.length) {
        throw error;
      }
      await this.recover(targets, error);
      const code = signal.aborted ? "BROWSER.CANCELLED" : "BROWSER.UNAVAILABLE";
      throw egoErrors.create(code, { cause: error, details: { targets, cleanup: "confirmed" } });
    }
  }

  private async recover(targets: string[], cause: unknown): Promise<void> {
    const signal = AbortSignal.timeout(20_000);
    try {
      for (const target of targets) {
        if (!(await this.absent(target, signal))) {
          await this.close(target, signal);
        }
      }
    } catch (error) {
      throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
        cause: error,
        details: {
          targets,
          originalFailure: cause,
          userControl: isAppError(error) && error.code === "BROWSER.USER_CONTROL",
        },
      });
    }
  }

  private async close(target: string, signal: AbortSignal): Promise<void> {
    try {
      await this.browser.closeTarget(target, signal);
    } catch (error) {
      if (!pendingTargets(error).length || !(await this.absent(target, signal))) {
        throw error;
      }
    }
  }
}
