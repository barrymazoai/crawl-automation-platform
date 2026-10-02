import {
  browserResources,
  type BrowserResourceId,
} from "@crawl-automation/platform/browser-routing";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";
import type { PermitOwner } from "@crawl-automation/platform";
import type { ResourceStore } from "./resource-service.js";

/** Read-only admission before executor receipts or browser access; never changes a foreign permit. */
export async function assertBrowserPermit(at: {
  resources: Pick<ResourceStore, "findHeld">;
  owner: PermitOwner;
  resourceId: BrowserResourceId;
}): Promise<void> {
  const permit = await at.resources.findHeld(at.owner.permitId);
  const hosts = browserResources(permit?.resources ?? []);
  if (!permit || !sameOwner(permit, at.owner) || hosts.length !== 1 || hosts[0] !== at.resourceId) {
    throw resourceGateErrors.create("RESOURCE.BROWSER_PERMIT_MISMATCH", {
      details: { ...at.owner, resourceId: at.resourceId, heldResources: permit?.resources ?? [] },
    });
  }
}

function sameOwner(permit: PermitOwner, owner: PermitOwner): boolean {
  return (
    permit.permitId === owner.permitId &&
    permit.workflowId === owner.workflowId &&
    permit.runId === owner.runId
  );
}
