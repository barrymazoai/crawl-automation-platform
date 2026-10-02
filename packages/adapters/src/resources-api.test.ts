import { expect, it, vi } from "vitest";
import { ResourcesApi } from "./resources-api.js";

it("uses the mutation envelope and surfaces failed API responses", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockResolvedValueOnce(
    Response.json({ result: { data: { results: [], released: ["permit-one"] } } }),
  );
  fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  const api = new ResourcesApi("http://localhost/trpc/", fetch);
  const signal = new AbortController().signal;
  expect(await api.verifyStops(signal)).toEqual({ results: [], released: ["permit-one"] });
  expect(fetch).toHaveBeenCalledWith(
    "http://localhost/trpc/resources.verifyStops",
    expect.objectContaining({
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(api.verifyStops(signal)).rejects.toMatchObject({ code: "PERMIT.SWEEP_API_FAILED" });
});
