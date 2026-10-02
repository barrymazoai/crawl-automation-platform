import { expect, it, vi } from "vitest";
import { appWith, post } from "../testing/app-with.js";

it("exposes unauthenticated exact-permit and bounded sweep mutations", async () => {
  const verifyStop = vi.fn(async (permitId: string) => ({
    permitId,
    released: true,
    executions: [],
  }));
  const verifyStops = vi.fn(async () => ({ results: [], released: [] }));
  const app = appWith({ resources: { verifyStop, verifyStops } });
  const response = await app.request(
    "/trpc/resources.verifyStop",
    post({ permitId: "permit-ocr" }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    result: { data: { permitId: "permit-ocr", released: true, executions: [] } },
  });
  expect(verifyStop).toHaveBeenCalledExactlyOnceWith("permit-ocr");
  expect((await app.request("/trpc/resources.verifyStops", post({}))).status).toBe(200);
  expect(verifyStops).toHaveBeenCalledOnce();
  expect(
    (await app.request("/trpc/resources.verifyStop", post({ permitId: "", force: true }))).status,
  ).toBe(400);
  expect((await app.request("/trpc/resources.verifyStops", post({ force: true }))).status).toBe(
    400,
  );
});
