import { expect, it, vi } from "vitest";
import { appWith, post } from "./testing/app-with.js";

it("starts a preview prune by default", async () => {
  const status = { running: { removeFiles: false, startedAt: "t" }, last: null, lastError: null };
  const start = vi.fn(() => status);
  const response = await appWith({ journalPrune: { start } }).request(
    "/trpc/storage.journalPrune",
    post({}),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ result: { data: status } });
  expect(start).toHaveBeenCalledExactlyOnceWith({ dryRun: true });
});

it("rejects unknown input before calling the service", async () => {
  const start = vi.fn();
  const response = await appWith({ journalPrune: { start } }).request(
    "/trpc/storage.journalPrune",
    post({ dryRun: "no" }),
  );
  expect(response.status).toBe(400);
  expect(start).not.toHaveBeenCalled();
});

it("returns a registered error when this API has no journal prune", async () => {
  const response = await appWith({}).request("/trpc/storage.journalPruneStatus");
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("JOURNAL_PRUNE.NOT_CONFIGURED");
});
