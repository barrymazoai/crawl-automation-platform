import { expect, it, vi } from "vitest";
import { UsageService } from "./usage-service.js";
import type { UsageSummary } from "./usage-model.js";

const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };
const fixture: UsageSummary = {
  channels: [
    {
      channel: "gnc",
      products: 2,
      attempts: 3,
      freshCaptures: 1,
      captureReuses: 2,
      credits: 5,
      unknownCreditCalls: 1,
      modelTextCalls: 2,
      modelImageCalls: 1,
      modelEnrichmentCalls: 0,
      ocrCalls: 1,
      brandRequests: 0,
      brandReuses: 0,
      preparationsRecomputed: 4,
      preparationsReused: 0,
      inputTokens: 0,
      outputTokens: 0,
      modelCallsWithoutTokens: 3,
    },
  ],
  steps: [
    {
      channel: "gnc",
      kind: "activity",
      step: "interpretText",
      samples: 2,
      medianMs: 15,
      p90Ms: 19,
    },
  ],
  unattributedEvents: 2,
};

it("returns channel costs, attempts, reuse, step latency and explicit coverage from fixtures", async () => {
  const summarize = vi.fn(async () => fixture);
  const result = await new UsageService({ summarize }).summary({ ...window, channel: "gnc" });
  expect(summarize).toHaveBeenCalledWith({ ...window, channel: "gnc" });
  expect(result).toMatchObject({ ...fixture, window: { ...window, channel: "gnc" } });
  expect(result.basis.credits).toContain("unknownCreditCalls");
});

it.each([
  { ...window, to: window.from },
  { ...window, channel: "unknown" },
  { from: "bad", to: window.to },
])("rejects invalid reporting windows before reading", async (input) => {
  const summarize = vi.fn(async () => fixture);
  await expect(new UsageService({ summarize }).summary(input)).rejects.toThrow();
  expect(summarize).not.toHaveBeenCalled();
});
