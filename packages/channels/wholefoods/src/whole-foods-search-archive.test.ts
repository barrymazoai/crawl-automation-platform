import { ListingPages, type ListingPolicyRequest } from "@crawl-automation/channels-core";
import type { ScraperApiRequest } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { answer, setup, sourceUrl } from "./whole-foods-search-test-support.js";

it("archives and reads back every page and empty try before parsing, then reuses all paid answers", async () => {
  const { reader } = setup([], { size: 2 });
  const bodies = [answer([1, 2], 3), answer([]), answer([3], 3), answer([1, 2], 3), answer([3], 3)];
  const saved = new Map<string, Uint8Array>();
  const verified = new Set<string>();
  const remote = {
    read: vi.fn(async (key: string) => {
      const bytes = saved.get(key) ?? null;
      if (bytes) {
        verified.add(key);
      }
      return bytes;
    }),
    create: vi.fn(async (key: string, bytes: Uint8Array) => {
      expect(saved.has(key)).toBe(false);
      saved.set(key, Buffer.from(bytes));
      return "created" as const;
    }),
  };
  const get = vi.fn(async (request: ScraperApiRequest) => ({
    status: 200,
    url: request.target,
    contentType: "application/json",
    contentEncoding: null,
    bytes: Buffer.from(bodies[get.mock.calls.length - 1] ?? ""),
    creditCost: 1,
  }));
  const pages = new ListingPages({
    client: { provider: "scraperapi-sync/1", get },
    remote,
    settings: {
      routeId: "test",
      egressId: "test",
      channels: {},
      defaults: { countryCode: "us", sessionNumber: null, render: false, premium: false },
    },
  });
  const signal = new AbortController().signal;
  const read = async (request: ListingPolicyRequest) => {
    const result = await pages.read(
      { ...request, scanId: "scan", channel: "wholefoods", origins: reader.origins ?? [] },
      signal,
    );
    expect(verified.has(result.archiveKey)).toBe(true);
    expect(verified.has(result.archiveKey.replace(/\.json$/, ".record.json"))).toBe(true);
    return result;
  };
  const context = { read, sourceUrl, signal, pause: async () => undefined };
  const first = await reader.readList?.(context);
  expect(first).toMatchObject({ complete: true, credits: 5, metrics: { unionSize: 3 } });
  expect(saved.size).toBe(10);
  const second = await reader.readList?.(context);
  expect(second).toMatchObject({ complete: true, credits: 5 });
  expect(second?.metrics.attempts.every((attempt) => attempt.fromArchive)).toBe(true);
  expect(get).toHaveBeenCalledTimes(5);
  expect(remote.create).toHaveBeenCalledTimes(10);
});
