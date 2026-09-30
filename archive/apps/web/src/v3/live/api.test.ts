import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiFailure,
  makePending,
  pendingStorageKey,
  readPending,
  sendPending,
} from "./api";

const brand = {
  id: "460a4ce5-a679-4409-a24e-e65d75cb3db2",
  name: "Fixture",
  note: "",
  revision: 1,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
};
afterEach(() => vi.unstubAllGlobals());
describe("live API recovery boundary", () => {
  it("reuses the same frozen body and key after a lost response", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(brand), { status: 201 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const body = { name: "Fixture", note: "" };
    const pending = makePending("/brands", "POST", body, "创建 Brand", "brand");
    body.name = "changed after submit";
    await expect(sendPending(pending)).rejects.toMatchObject({
      uncertain: true,
    });
    await expect(sendPending(pending)).resolves.toEqual(brand);
    for (const call of fetcher.mock.calls) {
      expect(call[1].headers["Idempotency-Key"]).toBe(pending.key);
      expect(call[1].body).toBe('{"name":"Fixture","note":""}');
      expect(call[1].headers.Authorization).toBeUndefined();
    }
  });
  it("round-trips pending request across reload without a new identity", () => {
    const pending = makePending(
      "/brands",
      "POST",
      { name: "Fixture" },
      "创建",
      "brand",
    );
    const storage = {
      getItem: (key: string) =>
        key === pendingStorageKey ? JSON.stringify(pending) : null,
    } as Storage;
    expect(readPending(storage)).toEqual(pending);
    expect(
      readPending({ getItem: () => null } as unknown as Storage),
    ).toBeNull();
  });
  it("fails closed on corrupt or external-target pending records", () => {
    expect(() =>
      readPending({ getItem: () => "{" } as unknown as Storage),
    ).toThrow();
    expect(() =>
      makePending("https://example.com", "POST", {}, "invalid", "brand"),
    ).toThrow();
  });
  it.each([400, 401, 404, 409])(
    "treats an ordinary %s rejection as definitive",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({
                error: { code: "REVISION_CONFLICT", message: "Conflict" },
              }),
              { status },
            ),
          ),
      );
      await expect(
        sendPending(makePending("/brands", "POST", {}, "test", "brand")),
      ).rejects.toMatchObject({ uncertain: false, code: "REVISION_CONFLICT" });
    },
  );
  it.each(["REQUEST_ID_CONFLICT", "RECEIPT_INCOMPLETE"])(
    "keeps %s for manual confirmation",
    async (code) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({
                error: { code, message: "Needs confirmation" },
              }),
              { status: 409 },
            ),
          ),
      );
      await expect(
        sendPending(makePending("/brands", "POST", {}, "test", "brand")),
      ).rejects.toMatchObject({ uncertain: true });
    },
  );
  it.each([
    new Response("unavailable", { status: 502 }),
    new Response(
      JSON.stringify({ error: { code: "DATABASE_BUSY", message: "Busy" } }),
      {
        status: 503,
      },
    ),
    new Response(JSON.stringify({ ok: true })),
  ])("does not claim success for uncertain responses", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const failure = await sendPending(
      makePending("/brands", "POST", {}, "test", "brand"),
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.uncertain).toBe(true);
  });
});
