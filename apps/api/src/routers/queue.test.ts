import type { QueueService } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../server.js";
import type { ApiContext } from "../trpc.js";

function appWith(queue: Partial<QueueService>) {
  return createHttpApp({ queue } as ApiContext);
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("shared Amazon queue API", () => {
  it("exposes the migration preview as a read-only query", async () => {
    const counts = { pending: 17, alreadyCopied: 4 };
    const amazonMigrationPreview = vi.fn(async () => counts);
    const app = appWith({ amazonMigrationPreview });
    const response = await app.request("/trpc/queue.amazonMigrationPreview");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: counts } });
    expect(amazonMigrationPreview).toHaveBeenCalledExactlyOnceWith();
    const write = await app.request("/trpc/queue.amazonMigrationPreview", post({}));
    expect(write.status).toBe(405);
    expect(amazonMigrationPreview).toHaveBeenCalledOnce();
  });

  it("accepts Amazon URLs using the shared batch input", async () => {
    const add = vi.fn(async () => ({ added: 1 }));
    const list = {
      channel: "amazon",
      batchId: "11111111-1111-4111-8111-111111111111",
      label: "Amazon scan",
      products: [
        {
          sourceId: "22222222-2222-4222-8222-222222222222",
          url: "https://www.amazon.com/dp/B000000001",
          listingId: "B000000001",
        },
      ],
    };
    const response = await appWith({ add }).request("/trpc/queue.add", post(list));
    expect(response.status).toBe(200);
    expect(add).toHaveBeenCalledExactlyOnceWith({
      ...list,
      products: [{ ...list.products[0], variantId: null }],
    });
  });

  it("rejects legacy Amazon link-batch inputs before calling the service", async () => {
    const add = vi.fn(async () => ({ added: 0 }));
    const response = await appWith({ add }).request(
      "/trpc/queue.add",
      post({
        channel: "amazon",
        campaignId: "old-campaign",
        batches: [],
      }),
    );
    expect(response.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });
});
