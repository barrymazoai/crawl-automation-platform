import { expect, it, vi } from "vitest";
import { platformErrors } from "@crawl-automation/platform";
import { safeErrorSummary } from "@crawl-automation/platform/errors/summary";
import { writeOnce } from "./write-once.js";

it.each([null, Buffer.from("wrong")])(
  "keeps a write failure after unverified read-back (%s)",
  async (saved) => {
    const cause = new Error("Local write failed token=private");
    const store = {
      create: vi.fn().mockRejectedValue(cause),
      read: vi.fn().mockResolvedValue(saved),
    };
    const result = writeOnce(
      store,
      { key: "local", bytes: Buffer.from("expected") },
      {
        signal: new AbortController().signal,
        mismatch: () => platformErrors.create("DATABASE.UNAVAILABLE"),
      },
    );
    await expect(result).rejects.toMatchObject({ code: "DATABASE.UNAVAILABLE", cause });
    await result.catch((error: unknown) =>
      expect(safeErrorSummary(error)).toMatchObject({ message: "Local write failed [redacted]" }),
    );
    expect(store.create).toHaveBeenCalledOnce();
    expect(store.read).toHaveBeenCalledOnce();
  },
);

it("accepts a lost write acknowledgement when the original bytes read back", async () => {
  const bytes = Buffer.from("expected");
  const store = {
    create: vi.fn().mockRejectedValue(new Error("lost")),
    read: vi.fn().mockResolvedValue(bytes),
  };
  await expect(
    writeOnce(
      store,
      { key: "local", bytes },
      {
        signal: new AbortController().signal,
        mismatch: () => platformErrors.create("DATABASE.UNAVAILABLE"),
      },
    ),
  ).resolves.toBeUndefined();
  expect(store.create).toHaveBeenCalledOnce();
});
