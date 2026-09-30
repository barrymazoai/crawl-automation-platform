import { describe, expect, it, vi } from "vitest";
import { appWith, post } from "./testing/app-with.js";

const requestId = "44444444-4444-4444-8444-444444444444";
const sourceId = "33333333-3333-4333-8333-333333333333";
const accepted = { kind: "list", runId: requestId, channel: "gnc", label: "two", added: 2 };

describe("runs router", () => {
  it("accepts a list run and passes the checked input to the service", async () => {
    const runs = { submit: vi.fn(async () => accepted) };
    const body = {
      kind: "list",
      requestId,
      channel: "gnc",
      label: "two",
      products: [
        { sourceId, url: "https://www.gnc.com/877080.html" },
        { sourceId, url: "https://www.gnc.com/350213.html" },
      ],
    };
    const response = await appWith({ runs }).request("/trpc/runs.submit", post(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { data: accepted } });
    expect(runs.submit).toHaveBeenCalledWith(body);
  });

  it("refuses a list run on Amazon (Amazon keeps its own queue) and an empty list", async () => {
    const runs = { submit: vi.fn() };
    const app = appWith({ runs });
    const amazon = { kind: "list", requestId, channel: "amazon", label: "x", products: [] };
    const empty = { kind: "list", requestId, channel: "gnc", label: "x", products: [] };
    for (const body of [{ ...amazon, products: [{ sourceId, url: "https://a.test/x" }] }, empty]) {
      expect((await app.request("/trpc/runs.submit", post(body))).status).toBe(400);
    }
    expect(runs.submit).not.toHaveBeenCalled();
  });
});
