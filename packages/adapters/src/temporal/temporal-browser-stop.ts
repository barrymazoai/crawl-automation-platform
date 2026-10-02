import type { BrowserStopGateway } from "../permit-stop-verifier.js";
import type { PermitOwner } from "@crawl-automation/platform";
import { browserResources, browserTaskQueue } from "@crawl-automation/platform/browser-routing";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";
import type { Client } from "@temporalio/client";
import { codedFailure } from "./coded-failure.js";

/** Recovery has its own workflow. It never schedules the original business activity. */
export class TemporalBrowserStop implements BrowserStopGateway {
  constructor(private readonly client: Client) {}

  async verify(owner: PermitOwner, resources: string[]): Promise<void> {
    const hosts = browserResources(resources);
    if (hosts.length !== 1 || !hosts[0]) {
      throw resourceGateErrors.create("RESOURCE.BROWSER_PERMIT_MISMATCH", { details: { owner } });
    }
    // The workflow input is strict: send the owner's identity only, never the whole held-permit row
    // (its resources/grantedAt/cleanup made every verification fail its first workflow task, 2026-10-02).
    const exact = { permitId: owner.permitId, workflowId: owner.workflowId, runId: owner.runId };
    const handle = await this.client.workflow.start("VerifyBrowserStopWorkflow", {
      workflowId: `verify-stop-${owner.permitId}`,
      taskQueue: browserTaskQueue(hosts[0]),
      args: [{ owner: exact, resourceId: hosts[0] }],
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowExecutionTimeout: "3 minutes",
    });
    try {
      await handle.result();
    } catch (error) {
      throw codedFailure(error);
    }
  }
}
