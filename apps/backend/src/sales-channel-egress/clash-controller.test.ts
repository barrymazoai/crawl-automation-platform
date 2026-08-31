import { describe, expect, it, vi } from "vitest";
import { ClashControllerSelector } from "./clash-controller.js";

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe("ClashControllerSelector", () => {
  it("selects and verifies a proxy using the controller directly", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proxies: { "GNC出口": { all: ["美国德州ip"], now: "美国华盛顿ip" } } }))
      .mockResolvedValueOnce(jsonResponse(null, 204))
      .mockResolvedValueOnce(jsonResponse({ proxies: { "GNC出口": { all: ["美国德州ip"], now: "美国德州ip" } } }));
    const selector = new ClashControllerSelector({
      baseUrl: "http://127.0.0.1:9097/",
      secret: "controller-secret",
      fetch: request,
    });

    await selector.select("GNC出口", "美国德州ip");

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[0]).toBe("http://127.0.0.1:9097/proxies/GNC%E5%87%BA%E5%8F%A3");
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ name: "美国德州ip" }),
      headers: { authorization: "Bearer controller-secret", "content-type": "application/json" },
    });
    await selector.close();
  });

  it("retries while the controller is reloading its selectors", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proxies: {} }))
      .mockResolvedValueOnce(jsonResponse({ proxies: { "GNC出口": { all: ["美国华盛顿ip"], now: "美国德州ip" } } }))
      .mockResolvedValueOnce(jsonResponse(null, 204))
      .mockResolvedValueOnce(jsonResponse({ proxies: { "GNC出口": { all: ["美国华盛顿ip"], now: "美国华盛顿ip" } } }));
    const selector = new ClashControllerSelector({
      baseUrl: "http://127.0.0.1:9097",
      secret: "",
      retryIntervalMs: 1,
      deadlineMs: 100,
      fetch: request,
    });

    await selector.select("GNC出口", "美国华盛顿ip");

    expect(request).toHaveBeenCalledTimes(4);
    await selector.close();
  });
});
