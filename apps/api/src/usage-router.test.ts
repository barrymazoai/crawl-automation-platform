import { expect, it, vi } from "vitest";
import { UsageService } from "@crawl-automation/app";
import { usageRouter } from "./routers/usage.js";
import type { ApiContext } from "./trpc.js";

it("exposes a read-only validated usage summary", async () => {
  const summarize = vi.fn(async () => ({ channels: [], steps: [], unattributedEvents: 0 }));
  const caller = usageRouter.createCaller({ usage: new UsageService({ summarize }) } as ApiContext);
  const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };
  await expect(caller.summary(window)).resolves.toMatchObject({ window, channels: [] });
  await expect(caller.summary({ ...window, to: window.from })).rejects.toThrow();
  expect(summarize).toHaveBeenCalledOnce();
});
