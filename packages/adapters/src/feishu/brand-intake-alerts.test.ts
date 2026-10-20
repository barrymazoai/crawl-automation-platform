import { expect, it, vi } from "vitest";
import type { BrandEnrichmentRun } from "@crawl-automation/v3-contracts";
import { FeishuBrandIntakeAlerts } from "./brand-intake-alerts.js";

const run: BrandEnrichmentRun = {
  runId: "6f1e9e44-7d7e-4e0a-9d43-0d1d3f3b2a11",
  requestId: "1518d203-0000-4000-8000-000000000000",
  parentRunId: null,
  role: "request",
  brandName: "Blood Sugar Friendly",
  brandUrl: "https://bloodsugarfriendly.com/",
  companyId: null,
  workflowId: "brand-enrichment-6f1e9e44",
  state: "running",
  stage: "products",
  summary: null,
  failureReason: null,
  createdAt: new Date("2026-10-20T10:00:00Z"),
  updatedAt: new Date("2026-10-20T12:00:00Z"),
};

it("posts a red card through the shared Feishu sender, loading the webhook once", async () => {
  const send = vi.fn(async () => ({ sent: true as const }));
  const notifier = vi.fn(async () => ({ enabled: true, send }));
  const log = { warn: vi.fn(), error: vi.fn() };
  const alerts = new FeishuBrandIntakeAlerts({
    webhookFile: "/private/feishu.webhook",
    log,
    notifier,
  });

  await alerts.timedOut(run, 2 * 3_600_000);
  await alerts.timedOut(run, 2 * 3_600_000);

  expect(notifier).toHaveBeenCalledOnce();
  expect(notifier).toHaveBeenCalledWith("/private/feishu.webhook");
  expect(send).toHaveBeenCalledWith({
    title: "品牌补全超时：Blood Sugar Friendly",
    color: "red",
    markdown: expect.stringContaining("已处理超过 2 小时"),
  });
  const card = (send.mock.calls[0] as unknown as [{ markdown: string }])[0];
  expect(card.markdown).toContain(run.requestId);
  expect(card.markdown).toContain(run.runId);
  expect(log.warn).not.toHaveBeenCalled();
});

it("logs a card the webhook refused or could not send", async () => {
  const send = vi.fn(async () => ({ sent: false as const, reason: "no webhook" }));
  const log = { warn: vi.fn(), error: vi.fn() };
  const alerts = new FeishuBrandIntakeAlerts({
    webhookFile: undefined,
    log,
    notifier: async () => ({ enabled: false, send }),
  });
  await alerts.timedOut(run, 2 * 3_600_000);
  expect(log.warn).toHaveBeenCalledWith(
    { runId: run.runId, reason: "no webhook" },
    "timeout card not sent",
  );
});

it("uses tools/notify/feishu.mjs itself: without a webhook file nothing is sent", async () => {
  const log = { warn: vi.fn(), error: vi.fn() };
  await new FeishuBrandIntakeAlerts({ webhookFile: undefined, log }).timedOut(run, 3_600_000);
  expect(log.warn).toHaveBeenCalledWith(
    { runId: run.runId, reason: "no webhook" },
    "timeout card not sent",
  );
});
