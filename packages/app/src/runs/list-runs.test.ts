import type { ChannelAdapter } from "@crawl-automation/channels-core";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { describe, expect, it, vi } from "vitest";
import type { AddToQueue } from "../queue/queue-model.js";
import { ListRuns } from "./list-runs.js";
import type { ListRun } from "./run-model.js";

const sourceId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";

/** A channel whose product pages are https://shop.example/p/<id>[?size=<variant>]. */
const adapter = {
  id: "gnc",
  productAddress(url: string) {
    const parsed = new URL(url);
    if (parsed.hostname !== "shop.example") {
      throw new Error("CHANNEL.URL_REJECTED");
    }
    const listingId = parsed.pathname.split("/").at(-1) ?? "";
    return {
      url: `https://shop.example/p/${listingId}`,
      listingId,
      variantId: parsed.searchParams.get("size"),
    };
  },
} as unknown as ChannelAdapter;

function setup() {
  const queue = {
    add: vi.fn(async (input: AddToQueue) => ({
      added: "products" in input ? input.products.length : 0,
    })),
  };
  return { queue, runs: new ListRuns({ registry: new ChannelRegistry([adapter]), queue }) };
}

const run = (urls: string[]): ListRun => ({
  kind: "list",
  requestId,
  channel: "gnc",
  label: "two products",
  products: urls.map((url) => ({ sourceId, url })),
});

describe("ListRuns", () => {
  it("queues every page as one list under the run's request ID", async () => {
    const { queue, runs } = setup();
    const result = await runs.submit(
      run(["https://shop.example/p/877080", "https://shop.example/p/350213?size=120"]),
    );
    expect(result).toEqual({
      kind: "list",
      runId: requestId,
      channel: "gnc",
      label: "two products",
      added: 2,
    });
    expect(queue.add).toHaveBeenCalledWith({
      channel: "gnc",
      batchId: requestId,
      label: "two products",
      products: [
        { sourceId, url: "https://shop.example/p/877080", listingId: "877080", variantId: null },
        { sourceId, url: "https://shop.example/p/350213", listingId: "350213", variantId: "120" },
      ],
    });
  });

  it("queues nothing when one page belongs to another site", async () => {
    const { queue, runs } = setup();
    await expect(
      runs.submit(run(["https://shop.example/p/1", "https://other.example/p/2"])),
    ).rejects.toThrow("CHANNEL.URL_REJECTED");
    expect(queue.add).not.toHaveBeenCalled();
  });
});
