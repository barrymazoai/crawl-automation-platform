import {
  codexGroupAbsent,
  errorCodeOf,
  withPermitExecution,
  type PermitExecutionIdentity,
  type PermitExecutionLedger,
  type PermitOwner,
} from "@crawl-automation/platform";
import { browserResources } from "@crawl-automation/platform/browser-routing";
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

type CodexIdentity = Extract<PermitExecutionIdentity, { kind: "codex" }>;

/**
 * Same R59 providers and journal, with read-only OCR recovery and host-routed browser cleanup. A codex execution of a
 * permit that holds no browser (the label model on Server 一, 2026-11-12) is proven on this host: its recorded process
 * group is gone. Before, every codex execution went to the browser check, which refuses a permit without a browser
 * (RESOURCE.BROWSER_PERMIT_MISMATCH), so a label model worker that stopped mid-turn kept its permits for good.
 */
export class ExecutorStopVerifier implements PermitStopVerifier {
  constructor(
    private readonly deps: {
      ledger: PermitExecutionLedger;
      resources: ResourceStore;
      browser: BrowserStopGateway;
      ocr?: OcrApiSettings | undefined;
      control?: OcrHttpJobControl;
      /** Proof that a codex process group is gone from this host; codexGroupAbsent by default. */
      codexAbsent?: (identity: CodexIdentity) => Promise<Record<string, unknown> | null>;
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
      if (browserResources(permit.resources).length === 0) {
        await this.codex(permit, failures);
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

  /** Codex turns of a permit without a browser: their process group must be gone from this host. */
  private async codex(
    permit: HeldPermit,
    failures: Map<string, { reason?: string; cause?: string }>,
  ) {
    const absent = this.deps.codexAbsent ?? codexGroupAbsent;
    for (const execution of permit.cleanup?.executions ?? []) {
      const identity = execution.identity as PermitExecutionIdentity;
      if (execution.stoppedAt !== null || identity.kind !== "codex") {
        continue;
      }
      const proof = await absent(identity);
      if (proof) {
        await this.deps.ledger.prove(permit, identity, proof);
      } else {
        failures.set(identity.executionId, { reason: "codex_process_present_or_other_host" });
      }
    }
  }

  private async browser(
    permit: HeldPermit,
    failures: Map<string, { reason?: string; cause?: string }>,
  ) {
    const hasBrowser = browserResources(permit.resources).length > 0;
    const pending = (permit.cleanup?.executions ?? []).filter(
      (entry) =>
        entry.stoppedAt === null &&
        (String(entry.identity.kind).startsWith("browser") ||
          (entry.identity.kind === "codex" && hasBrowser)),
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
