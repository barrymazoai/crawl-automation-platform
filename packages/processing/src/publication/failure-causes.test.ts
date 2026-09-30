import { describe, expect, it, vi } from "vitest";
import { platformErrors, type ObjectStore } from "@crawl-automation/platform";
import { claimOnce } from "./claim-once.js";
import { claimIntent } from "../step/intent-claim.js";
import { decodeRecord } from "../results/result-record.js";

const signal = () => new AbortController().signal;
const fail = () => platformErrors.create("DATABASE.UNAVAILABLE");
const original = new Error("provider disconnected before acknowledgement");

function store(): ObjectStore {
  return {
    create: vi.fn(async () => {
      throw original;
    }),
    read: vi.fn(async () => null),
  };
}

describe("claim failure provenance", () => {
  it("retains a create failure even when the publication callback ignores its cause", async () => {
    const objects = store();
    await expect(
      claimOnce(
        objects,
        { key: "claim", bytes: Buffer.from("intent") },
        {
          signal: signal(),
          createFailed: fail,
          exists: fail,
          unverified: fail,
        },
      ),
    ).rejects.toMatchObject({ cause: original });
    expect(objects.create).toHaveBeenCalledOnce();
    expect(objects.read).not.toHaveBeenCalled();
  });

  it("retains both intent-write and saved-intent parse failures without another write", async () => {
    const objects = store();
    const claim = {
      store: objects,
      key: "intent",
      intent: { input: {}, nonce: "one" },
      parse: () => {
        throw original;
      },
      limit: 1000,
      fail,
    };
    await expect(claimIntent(claim, signal())).rejects.toMatchObject({ cause: original });
    vi.mocked(objects.create).mockResolvedValue("created");
    vi.mocked(objects.read).mockResolvedValue(Buffer.from("{}"));
    await expect(claimIntent(claim, signal())).rejects.toMatchObject({ cause: original });
    expect(objects.create).toHaveBeenCalledTimes(2);
  });

  it("retains malformed JSON as an integrity failure's cause", () => {
    expect(() => decodeRecord({ parseRecord: (raw) => raw, fail }, Buffer.from("{"))).toThrow(
      expect.objectContaining({ cause: expect.any(SyntaxError) }),
    );
  });
});
