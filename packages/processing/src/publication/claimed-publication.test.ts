import { expect, it, vi } from "vitest";
import { platformErrors } from "@crawl-automation/platform";
import { claimedPublish } from "./claimed-publication.js";
import { MemoryStore } from "../testing/memory-store.js";

it.each([false, true])(
  "settles a publication exception by read-back only (saved=%s)",
  async (saved) => {
    const local = new MemoryStore();
    const remote = new MemoryStore();
    const cause = new Error("Upload disconnected");
    const create = remote.create.bind(remote);
    const writes = vi.spyOn(remote, "create").mockImplementation(async (key, bytes) => {
      if (key !== "output") {
        return create(key, bytes);
      }
      if (saved) {
        await create(key, bytes);
      }
      throw cause;
    });
    const fail = () => platformErrors.create("DATABASE.UNAVAILABLE");
    const result = claimedPublish(
      { local, remote },
      {
        key: "output",
        bytes: Buffer.from("expected"),
        limit: 100,
        markerPrefix: "claims",
      },
      {
        signal: new AbortController().signal,
        mismatch: fail,
        pending: fail,
        localUnverified: fail,
      },
    );
    if (saved) {
      await expect(result).resolves.toBeUndefined();
    } else {
      await expect(result).rejects.toMatchObject({ code: "DATABASE.UNAVAILABLE", cause });
    }
    expect(writes.mock.calls.filter(([key]) => key === "output")).toHaveLength(1);
  },
);
