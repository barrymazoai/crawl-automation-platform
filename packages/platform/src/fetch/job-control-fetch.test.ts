import { afterEach, expect, it, vi } from "vitest";
import { jobControlFetch } from "./job-control-fetch.js";

const transport = vi.hoisted(() => ({
  agents: [] as { destroy: ReturnType<typeof vi.fn> }[],
  fetch: vi.fn(),
}));
vi.mock("undici", () => ({
  Agent: class {
    destroy = vi.fn(async () => undefined);
    constructor() {
      transport.agents.push(this);
    }
  },
  fetch: transport.fetch,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  transport.agents.length = 0;
});

it("a dead shared dispatcher fails while each control query gets its own live dispatcher", async () => {
  const broken = new TypeError("fetch failed", {
    cause: Object.assign(new Error("destroyed"), { code: "UND_ERR_DESTROYED" }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw broken;
    }),
  );
  transport.fetch.mockImplementation(async () => Response.json({ state: "failed" }));
  const request = new Request("https://ocr.test/jobs/exact", {
    headers: { accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: new AbortController().signal,
  });
  await expect(globalThis.fetch(request)).rejects.toBe(broken);
  expect(await (await jobControlFetch(request)).json()).toEqual({ state: "failed" });
  await jobControlFetch(new Request(request));
  expect(transport.agents).toHaveLength(2);
  for (const [index, agent] of transport.agents.entries()) {
    expect(transport.fetch.mock.calls[index]?.[1]).toMatchObject({
      dispatcher: agent,
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    expect(agent.destroy).toHaveBeenCalledOnce();
  }
});

it("releases its connection on a failed query without retrying it", async () => {
  transport.fetch.mockRejectedValue(new TypeError("fetch failed"));
  await expect(jobControlFetch(new Request("https://ocr.test/jobs/exact"))).rejects.toThrow(
    "fetch failed",
  );
  expect(transport.fetch).toHaveBeenCalledOnce();
  expect(transport.agents[0]?.destroy).toHaveBeenCalledOnce();
});
