import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry, type ChannelAdapter } from "@crawl-automation/channels-core";
import { describe, expect, it, vi } from "vitest";
import { ProductRuns, type AcceptedProductRun, type ProductRunStore } from "./product-runs.js";

const runId = "11111111-1111-4111-8111-111111111111";
const sourceId = "33333333-3333-4333-8333-333333333333";
const url = "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr";
const resources = { queue: "resource", activities: {}, maxWaitSeconds: 900 };

function setup(startedRunId: string | null = null) {
  const accepted: AcceptedProductRun = {
    runId,
    workflowId: `product-run-${runId}`,
    channel: "swanson",
    brandId: "22222222-2222-4222-8222-222222222222",
    sourceId,
    url,
    startedRunId,
  };
  const store: ProductRunStore = {
    source: vi.fn(async () => ({ brandId: accepted.brandId, channel: "swanson" as const })),
    accept: vi.fn(async () => accepted),
    markStarted: vi.fn(async () => undefined),
  };
  const starter = { start: vi.fn(async () => ({ startedRunId: "temporal-run-1" })) };
  const sources = { sources: vi.fn(async () => []) };
  const runs = new ProductRuns({
    store,
    sources,
    starter,
    registry: new ChannelRegistry([swansonAdapter]),
    targets: {
      queues: { activities: "pipeline", plan: "plan", label: "label" },
      channels: { swanson: { resources } },
    },
  });
  return { runs, store, starter, sources };
}

const request = { kind: "product" as const, requestId: runId, sourceId, url };

describe("ProductRuns", () => {
  it("accepts the run, starts its workflow with the pipeline input and records the start", async () => {
    const { runs, store, starter, sources } = setup();

    expect(await runs.submit(request)).toBe(runId);

    expect(starter.start).toHaveBeenCalledWith(
      `product-run-${runId}`,
      expect.objectContaining({
        channel: "swanson",
        capture: "http",
        url,
        operationId: `product-${runId}`,
        resources,
      }),
    );
    expect(store.markStarted).toHaveBeenCalledWith(runId, "temporal-run-1");
    expect(sources.sources).not.toHaveBeenCalled();
    expect(starter.start).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceUrl: expect.anything() }),
    );
  });

  it("a repeated request of a started run starts nothing", async () => {
    const { runs, starter } = setup("temporal-run-1");

    await runs.submit(request);

    expect(starter.start).not.toHaveBeenCalled();
  });

  it("refuses a page of another site before storing anything", async () => {
    const { runs, store } = setup();

    await expect(
      runs.submit({ ...request, url: "https://www.example.com/p/other" }),
    ).rejects.toBeDefined();
    expect(store.accept).not.toHaveBeenCalled();
  });

  it.each(["wholefoods", "dtc"] as const)(
    "starts %s with its browser capability",
    async (channel) => {
      const wholeFoods = {
        id: channel,
        captureModes: ["browser"],
        assertBrandSource: vi.fn(),
        productAddress: (page: string) => ({ url: page, listingId: "B002CQU54Q", variantId: null }),
      } as unknown as ChannelAdapter;
      const store: ProductRunStore = {
        source: vi.fn(async () => ({ brandId: "b", channel })),
        accept: vi.fn(async (run) => ({ ...run, runId, workflowId: "w", startedRunId: null })),
        markStarted: vi.fn(async () => undefined),
      };
      const starter = { start: vi.fn(async () => ({ startedRunId: "temporal-run-2" })) };
      const runs = new ProductRuns({
        store,
        sources: {
          sources: async () => [
            { sourceId, brandId: "b", channel, url: page, brandName: "Test", enabled: true },
          ],
        },
        starter,
        registry: new ChannelRegistry([wholeFoods]),
        targets: {
          queues: { activities: "pipeline", plan: "plan", label: "label" },
          channels: { [channel]: { resources } },
        },
      });
      const page =
        "https://www.wholefoodsmarket.com/grocery/product/nordic-naturals-omega-b002cqu54q";

      expect(await runs.submit({ ...request, url: page })).toBe(runId);
      expect(starter.start).toHaveBeenCalledWith(
        "w",
        expect.objectContaining({ channel, capture: "browser" }),
      );
    },
  );

  it("refuses a channel without pipeline targets", async () => {
    const { runs, store } = setup();
    vi.mocked(store.source).mockResolvedValue({ brandId: "b", channel: "gnc" });

    await expect(runs.submit(request)).rejects.toMatchObject({ code: "RUN.CHANNEL_UNSUPPORTED" });
  });
});
