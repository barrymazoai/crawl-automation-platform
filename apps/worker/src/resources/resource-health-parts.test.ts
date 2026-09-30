import { createLogger } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import type { CoreParts } from "../core-parts.js";
import { buildResourceHealth } from "./resource-health-parts.js";

const { connectTemporal } = vi.hoisted(() => ({ connectTemporal: vi.fn() }));
vi.mock("@crawl-automation/platform", async (original) => ({
  ...(await original<typeof import("@crawl-automation/platform")>()),
  connectTemporal,
}));

it("logs once and never opens a connection when resourceHealth is missing", async () => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    name: "health-test",
    destination: {
      write: (line) => {
        lines.push(JSON.parse(line));
      },
    },
  });
  const health = buildResourceHealth({ config: {}, log } as CoreParts);
  expect(lines).toEqual([]);
  await health.run(new AbortController().signal);
  expect(connectTemporal).not.toHaveBeenCalled();
  expect(lines).toEqual([
    expect.objectContaining({
      msg: "resource health is not configured",
      runId: expect.any(String),
    }),
  ]);
});
