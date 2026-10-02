import { expect, it, vi } from "vitest";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";
import { SiteAnalysisSchema } from "@crawl-automation/v3-contracts";
import { TemporalSiteAnalyses } from "./temporal-site-analyses.js";
const analysis = SiteAnalysisSchema.parse({
  analysisId: "11111111-1111-4111-8111-111111111111",
  url: "https://shop.example/",
  state: "queued",
  limits: {},
  brands: [],
  archiveKeys: [],
  reasons: [],
});
const permit = {
  taskQueue: "v3.browser.mini-ego-space-1",
  resourceQueue: "resources",
  resourceId: "mini-ego-space-1",
  maxWaitSeconds: 300,
  gapAfterSeconds: 0,
};
it("starts on the configured host with one browser permit and duplicate execution protection", async () => {
  const start = vi.fn();
  const gateway = new TemporalSiteAnalyses({ workflow: { start } } as unknown as Client, permit);
  await gateway.start(analysis);
  expect(start).toHaveBeenCalledWith(
    "SiteAnalysisWorkflow",
    expect.objectContaining({
      workflowId: `site-analysis-${analysis.analysisId}`,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowIdConflictPolicy: "USE_EXISTING",
      taskQueue: permit.taskQueue,
      args: [
        expect.objectContaining({
          resources: {
            queue: "resources",
            maxWaitSeconds: 300,
            activities: { analyzeSiteInBrowser: [{ resourceId: permit.resourceId, units: 1 }] },
          },
        }),
      ],
    }),
  );
});
it("repeated requests after workflow completion never start another execution", async () => {
  const start = vi.fn(async () => {
    throw new WorkflowExecutionAlreadyStartedError(
      "already started",
      "workflow",
      "SiteAnalysisWorkflow",
    );
  });
  const gateway = new TemporalSiteAnalyses({ workflow: { start } } as unknown as Client, permit);
  await expect(gateway.start(analysis)).resolves.toBeUndefined();
  expect(start).toHaveBeenCalledOnce();
});
it("does not proceed without a browser permit", async () => {
  const start = vi.fn();
  await expect(
    new TemporalSiteAnalyses({ workflow: { start } } as unknown as Client, undefined).start(
      analysis,
    ),
  ).rejects.toMatchObject({ code: "SITE_ANALYSIS.NOT_CONFIGURED" });
  expect(start).not.toHaveBeenCalled();
});
it.each(["FAILED", "CANCELLED", "TIMED_OUT", "TERMINATED"])(
  "reports terminal %s without rerunning the business activity",
  async (status) => {
    const describe = vi.fn(async () => ({ status: { name: status } }));
    const gateway = new TemporalSiteAnalyses(
      { workflow: { getHandle: () => ({ describe }) } } as unknown as Client,
      permit,
    );
    expect(await gateway.failure(analysis.analysisId)).toContain(status.toLowerCase());
  },
);
