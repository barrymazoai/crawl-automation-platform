import { createLogger, type TemporalClient } from "@crawl-automation/platform";
import { asValue } from "awilix";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiConfigSchema } from "./config.js";
import { assembleContainer, buildContainer } from "./container.js";
import productionShaped from "./fixtures/api-config.json" with { type: "json" };
import { listen } from "./server.js";
import { post, query } from "./testing/app-with.js";

vi.mock("./config.js", async (original) => ({
  ...(await original<typeof import("./config.js")>()),
  loadApiConfig: vi.fn(async () => ApiConfigSchema.parse(productionShaped)),
}));
vi.mock("./container.js", async (original) => ({
  ...(await original<typeof import("./container.js")>()),
  buildContainer: vi.fn(),
}));
// Exercise the real HTTP app and tRPC context factory without opening a socket.
vi.mock("./server.js", async (original) => ({
  ...(await original<typeof import("./server.js")>()),
  listen: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function startupContainer() {
  const close = vi.fn(async () => undefined);
  const temporal = { client: {}, connection: {}, close } as unknown as TemporalClient;
  const container = assembleContainer({
    config: ApiConfigSchema.parse(productionShaped),
    log: createLogger({ name: "context-test", level: "error" }),
    temporal,
  });
  const loop = { run: vi.fn(async () => undefined) };
  container.register({
    deliveryRunner: asValue(loop),
    queueDispatcher: asValue(loop),
    cleanup: asValue(loop),
  });
  container.cradle.brandScanParts.runner = null;
  vi.mocked(buildContainer).mockResolvedValue(container);
  vi.mocked(listen).mockResolvedValue({ close: (done: () => void) => done() } as never);
  vi.stubEnv("V3_WORKER_HEALTH_FILE", "");
  vi.spyOn(process, "once").mockReturnValue(process);
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  return { container, exit };
}

describe("evidence through the API startup context", () => {
  it("passes the container's evidence service through the real HTTP context builder", async () => {
    vi.resetModules();
    const { container, exit } = startupContainer();
    const input = { channel: "amazon", url: "https://www.amazon.com/dp/B012345678" };
    const result = {
      key: "tests/v3/pages/amazon/B012345678/observation.html",
      sha256: "f".repeat(64),
      size: 44,
      capturedAt: "2026-09-30T01:02:03.000Z",
      finalUrl: input.url,
      status: 200,
    };
    const capture = vi.spyOn(container.cradle.evidence, "capture").mockResolvedValue(result);
    const saved = {
      operationId: "archived-operation",
      channel: "amazon" as const,
      listingId: "B012345678",
      variantId: null,
      capturedAt: result.capturedAt,
      url: input.url,
      sha256: result.sha256,
      byteSize: result.size,
      mediaType: "text/html",
      html: "<html>archived</html>",
    };
    const original = vi.spyOn(container.cradle.originals, "original").mockResolvedValue(saved);

    await import("./main.js");
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    const app = vi.mocked(listen).mock.calls[0]?.[0];
    expect(app).toBeDefined();
    const response = await app?.request("/trpc/evidence.capture", post(input));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ result: { data: result } });
    expect(capture).toHaveBeenCalledExactlyOnceWith(input);
    const lookup = { operationId: saved.operationId };
    const archived = await app?.request(`/trpc/evidence.original${query(lookup)}`);
    expect(archived?.status).toBe(200);
    expect(await archived?.json()).toEqual({ result: { data: saved } });
    expect(original).toHaveBeenCalledExactlyOnceWith(lookup);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
