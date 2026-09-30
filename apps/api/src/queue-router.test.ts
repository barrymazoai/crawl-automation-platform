import type { QueueService, QueueStatus } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./server.js";

/** Only the queue service is exercised here; the others are never called. */
function appWith(queue: Partial<QueueService>) {
  const unused = {} as never;
  return createHttpApp({
    runs: unused,
    queue: queue as QueueService,
    brands: unused,
    reviews: unused,
    products: unused,
    originals: unused,
    history: unused,
    resources: unused,
    fleet: unused,
    listingStates: unused,
    brandScans: unused,
    brandSources: unused,
  });
}

const paused: QueueStatus = {
  channel: "amazon",
  mode: "paused",
  readyLimit: 20,
  runningLimit: 40,
  counts: {},
  attention: 0,
};

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("queue procedures", () => {
  it("a status query without a channel is about Amazon's queue", async () => {
    const status = vi.fn(async () => paused);
    const response = await appWith({ status }).request("/trpc/queue.status");
    expect(response.status).toBe(200);
    expect(status).toHaveBeenCalledWith("amazon");
  });

  it("names the channel it acts on", async () => {
    const resume = vi.fn(async () => paused);
    const response = await appWith({ resume }).request(
      "/trpc/queue.resume",
      post({ channel: "gnc" }),
    );
    expect(response.status).toBe(200);
    expect(resume).toHaveBeenCalledWith("gnc");
  });

  it("refuses a product list for a channel it does not know, before any service runs", async () => {
    const add = vi.fn(async () => ({ added: 0 }));
    const list = {
      channel: "walmart",
      batchId: "33333333-3333-4333-8333-333333333333",
      label: "x",
      products: [],
    };
    const response = await appWith({ add }).request("/trpc/queue.add", post(list));
    expect(response.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });
});
