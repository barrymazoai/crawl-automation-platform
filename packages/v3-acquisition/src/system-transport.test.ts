import { describe, it, expect } from "vitest";
import { SystemHttpsTransport, DirectHttpsTransport, transportAddress, systemDns } from "./network.js";
import { AcquisitionError } from "./ports.js";

describe("system-resolved direct transport", () => {
  it("never pins or checks an address: the host resolves the name", async () => {
    const transport = new SystemHttpsTransport();
    expect(transport.targetResolution).toBe("system");
    expect(await transportAddress(new URL("https://m.media-amazon.com/x.jpg"), transport, systemDns, new AbortController().signal)).toBeUndefined();
  });
  it("still refuses a URL outside https or with credentials", async () => {
    const transport = new SystemHttpsTransport(), signal = AbortSignal.timeout(1000);
    await expect(transport.get(new URL("https://user:pw@m.media-amazon.com/x.jpg"), undefined, {}, signal)).rejects.toMatchObject({ code: "SOURCE.ORIGIN_BLOCKED" });
  });
  it("the pinned transport keeps its guard", async () => {
    await expect(new DirectHttpsTransport().get(new URL("https://m.media-amazon.com/x.jpg"), { address: "198.18.0.5", family: 4 }, {}, AbortSignal.timeout(1000)))
      .rejects.toBeInstanceOf(AcquisitionError);
  });
});
