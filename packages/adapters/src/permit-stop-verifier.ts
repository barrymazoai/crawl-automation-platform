import {
  errorCodeOf,
  withPermitExecution,
  type PermitExecutionLedger,
  type PermitOwner,
} from "@crawl-automation/platform";
import {
  OcrHttpJobControl,
  verifyOcrStop,
  type OcrApiSettings,
} from "@crawl-automation/processing";
import type {
  ExecutionStopResult,
  HeldPermit,
  PermitStopVerifier,
  ResourceStore,
} from "@crawl-automation/app";

export interface BrowserStopGateway {
  verify(owner: PermitOwner, resources: string[]): Promise<void>;
}

/** Same R59 providers and journal, with read-only OCR recovery and host-routed browser cleanup. */
export class ExecutorStopVerifier implements PermitStopVerifier {
  constructor(
    private readonly deps: {
      ledger: PermitExecutionLedger;
      resources: ResourceStore;
      browser: BrowserStopGateway;
      ocr?: OcrApiSettings | undefined;
      control?: OcrHttpJobControl;
    },
  ) {}

  async verify(permit: HeldPermit): Promise<ExecutionStopResult[]> {
    const failures = new Map<string, { reason?: string; cause?: string }>();
    await withPermitExecution({ owner: permit, ledger: this.deps.ledger }, async () => {
      for (const execution of permit.cleanup?.executions ?? []) {
        if (execution.stoppedAt !== null || execution.identity.kind !== "ocr") {
          continue;
        }
        const identity = execution.identity;
        if (typeof identity.executionId !== "string" || typeof identity.endpoint !== "string") {
          continue;
        }
        const result = await this.ocr(identity as Parameters<typeof verifyOcrStop>[0]["identity"]);
        failures.set(identity.executionId, result);
      }
      await this.browser(permit, failures);
    });
    const current = await this.deps.resources.findHeld(permit.permitId);
    return (current?.cleanup?.executions ?? []).map(({ identity, stoppedAt, proof }) => ({
      executionId: String(identity.executionId),
      kind: String(identity.kind),
      stopped: stoppedAt !== null && proof !== null,
      ...(stoppedAt === null
        ? (failures.get(String(identity.executionId)) ?? { reason: "executor_stop_unavailable" })
        : {}),
    }));
  }

  private async ocr(identity: Parameters<typeof verifyOcrStop>[0]["identity"]) {
    const settings = this.deps.ocr;
    if (!settings?.jobControl) {
      return { reason: "job_control_unavailable" };
    }
    const control = this.deps.control ?? new OcrHttpJobControl({ baseUrl: settings.baseUrl });
    return verifyOcrStop({ identity, settings, control, queryOnly: true });
  }

  private async browser(
    permit: HeldPermit,
    failures: Map<string, { reason?: string; cause?: string }>,
  ) {
    const pending = (permit.cleanup?.executions ?? []).filter(
      (entry) =>
        entry.stoppedAt === null &&
        (String(entry.identity.kind).startsWith("browser") || entry.identity.kind === "codex"),
    );
    if (pending.length === 0) {
      return;
    }
    try {
      await this.deps.browser.verify(permit, permit.resources);
    } catch (error) {
      for (const entry of pending) {
        failures.set(String(entry.identity.executionId), {
          reason: errorCodeOf(error) ?? String(error),
        });
      }
    }
  }
}
