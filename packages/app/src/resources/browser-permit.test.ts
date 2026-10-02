import { expect, it, vi } from "vitest";
import type { BrowserResourceId } from "@crawl-automation/platform/browser-routing";
import { assertBrowserPermit } from "./browser-permit.js";

const owner = { permitId: "permit-test", workflowId: "workflow", runId: "run" };
const hosts = ["mini-ego-space-1", "server2-ego-space-6"] as const;

it.each(hosts)("admits only the exact held resource and owner on %s", async (resourceId) => {
  const permit = { ...owner, resources: ["costco-brand-scan", resourceId], grantedAt: "now" };
  const resources = { findHeld: vi.fn(async () => permit) };
  await expect(assertBrowserPermit({ resources, owner, resourceId })).resolves.toBeUndefined();
  expect(resources.findHeld).toHaveBeenCalledExactlyOnceWith(owner.permitId);
  expect(permit.resources).toEqual(["costco-brand-scan", resourceId]);
});

it.each(hosts)(
  "rejects foreign, missing, ambiguous and wrong-owner permits on %s",
  async (resourceId) => {
    const foreign: BrowserResourceId = resourceId === hosts[0] ? hosts[1] : hosts[0];
    for (const permit of [
      null,
      { ...owner, resources: [foreign], grantedAt: "now" },
      { ...owner, resources: [resourceId, foreign], grantedAt: "now" },
      { ...owner, resources: ["costco-brand-scan"], grantedAt: "now" },
      { ...owner, permitId: "permit-other", resources: [resourceId], grantedAt: "now" },
      { ...owner, runId: "other-run", resources: [resourceId], grantedAt: "now" },
      { ...owner, workflowId: "other-workflow", resources: [resourceId], grantedAt: "now" },
    ]) {
      const before = structuredClone(permit);
      const resources = { findHeld: vi.fn(async () => permit), release: vi.fn() };
      await expect(assertBrowserPermit({ resources, owner, resourceId })).rejects.toMatchObject({
        code: "RESOURCE.BROWSER_PERMIT_MISMATCH",
      });
      expect(resources.release).not.toHaveBeenCalled();
      expect(permit).toEqual(before);
    }
  },
);
