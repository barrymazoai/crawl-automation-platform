import type { RunService } from "@crawl-automation/app";
import { appErrors } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./server.js";

const runId = "11111111-1111-4111-8111-111111111111";

/** Only the runs service is exercised here; the others are never called. */
function appWith(runs: Partial<RunService>) {
  const unused = {} as never;
  return createHttpApp({
    runs: runs as RunService,
    queue: unused,
    brands: unused,
    reviews: unused,
    products: unused,
    resources: unused,
    fleet: unused,
  });
}

describe("HTTP API", () => {
  it("answers the health check without any login", async () => {
    const response = await appWith({}).request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves a query as a plain GET", async () => {
    const list = vi.fn(async () => []);
    const input = encodeURIComponent(JSON.stringify({ channel: "swanson" }));

    const response = await appWith({ list }).request(`/trpc/runs.list?input=${input}`);

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ channel: "swanson", limit: 50 });
  });

  it("rejects invalid input before any service runs", async () => {
    const cancel = vi.fn();

    const response = await appWith({ cancel }).request("/trpc/runs.cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("returns an application error with its code and the right status", async () => {
    const settle = vi.fn(async () => {
      throw appErrors.create("RUN.STILL_RUNNING", { details: { runId } });
    });

    const response = await appWith({ settle }).request("/trpc/runs.settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { data: { app: unknown } } };
    expect(body.error.data.app).toEqual({ code: "RUN.STILL_RUNNING", details: { runId } });
  });
});
