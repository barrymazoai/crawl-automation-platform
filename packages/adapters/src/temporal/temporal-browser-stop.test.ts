import type { Client } from "@temporalio/client";
import { expect, it, vi } from "vitest";
import { TemporalBrowserStop } from "./temporal-browser-stop.js";

it.each(["mini-ego-space-1", "server2-ego-space-6"])(
  "routes cleanup to %s only",
  async (resource) => {
    const result = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ result }));
    const gateway = new TemporalBrowserStop({ workflow: { start } } as unknown as Client);
    const owner = { permitId: "permit-one", workflowId: "old-workflow", runId: "closed-run" };
    await gateway.verify(owner, ["costco-brand-scan", resource]);
    expect(start).toHaveBeenCalledWith(
      "VerifyBrowserStopWorkflow",
      expect.objectContaining({
        taskQueue: `v3.browser.${resource}`,
        args: [{ owner, resourceId: resource }],
        workflowIdConflictPolicy: "USE_EXISTING",
      }),
    );
    expect(result).toHaveBeenCalledOnce();
  },
);

it("refuses an ambiguous browser resource without scheduling a workflow", async () => {
  const start = vi.fn();
  const gateway = new TemporalBrowserStop({ workflow: { start } } as unknown as Client);
  await expect(
    gateway.verify({ permitId: "permit", workflowId: "workflow", runId: "run" }, [
      "mini-ego-space-1",
      "server2-ego-space-6",
    ]),
  ).rejects.toMatchObject({ code: "RESOURCE.BROWSER_PERMIT_MISMATCH" });
  expect(start).not.toHaveBeenCalled();
});
