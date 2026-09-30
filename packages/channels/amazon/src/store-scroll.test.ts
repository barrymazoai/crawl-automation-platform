import { describe, expect, it, vi } from "vitest";
import { scrollStorePage, STORE_SCROLL_POLICY, type StoreObservation } from "./store-scroll.js";
import { asinOne, asinTwo, observation } from "./testing/store-fakes.js";

function driverFor(states: StoreObservation[]) {
  let index = 0;
  return {
    snapshot: vi.fn(async () => states[Math.min(index++, states.length - 1)] as StoreObservation),
    advance: vi.fn(async (_more: boolean) => undefined),
  };
}

describe("Store scroll exhaustion", () => {
  it("requires three settled no-growth rounds after the initial observation", async () => {
    const driver = driverFor([observation()]);
    const result = await scrollStorePage(driver, STORE_SCROLL_POLICY);
    expect(result.proof).toEqual({
      rounds: 3,
      stableRounds: 3,
      noMore: true,
      bottom: true,
      ended: "stable",
    });
    expect(driver.advance).toHaveBeenCalledTimes(3);
    expect(result.snapshots).toHaveLength(1);
  });

  it("uses identities, not tile count, and retains virtualized products", async () => {
    const driver = driverFor([
      observation({ asins: [asinOne] }),
      observation({ asins: [asinTwo] }),
      observation({ asins: [asinOne] }),
    ]);
    const result = await scrollStorePage(driver, STORE_SCROLL_POLICY);
    expect(result.proof).toMatchObject({ rounds: 4, ended: "stable" });
    expect(result.snapshots.map((snapshot) => snapshot.asins)).toEqual([[asinOne], [asinTwo]]);
  });

  it("clicks load-more and restarts the stable count when it disappears", async () => {
    const driver = driverFor([
      observation({ more: true }),
      observation({ more: true }),
      observation(),
    ]);
    expect((await scrollStorePage(driver, STORE_SCROLL_POLICY)).proof.rounds).toBe(4);
    expect(driver.advance.mock.calls.map(([more]) => more)).toEqual([true, true, false, false]);
  });

  it.each([
    ["load-more remains", { more: true }],
    ["spinner remains", { loading: true }],
    ["not at the bottom", { bottom: false }],
  ])("caps without claiming exhaustion when %s", async (_label, state) => {
    const result = await scrollStorePage(driverFor([observation(state)]), {
      ...STORE_SCROLL_POLICY,
      maxRounds: 5,
    });
    expect(result.proof).toMatchObject({ ended: "capped", rounds: 5, stableRounds: 0 });
  });

  it("resets stability when late navigation or products arrive", async () => {
    const driver = driverFor([
      observation(),
      observation(),
      observation(),
      observation({ navigation: ["/stores/page/00000000-0000-0000-0000-000000000009"] }),
    ]);
    expect((await scrollStorePage(driver, STORE_SCROLL_POLICY)).proof.rounds).toBe(6);
  });

  it("resets stability when new tiles duplicate already-seen ASINs", async () => {
    const driver = driverFor([
      observation(),
      observation(),
      observation({ tileCount: 2 }),
      observation({ tileCount: 3 }),
    ]);
    expect((await scrollStorePage(driver, STORE_SCROLL_POLICY)).proof.rounds).toBe(6);
  });

  it.each([{ ready: false }, { blocked: true }, { invalidTiles: true }])(
    "never proves an unverified page complete: %j",
    async (state) => {
      const driver = driverFor([observation(state)]);
      expect((await scrollStorePage(driver, STORE_SCROLL_POLICY)).proof.ended).toBe("unverified");
      expect(driver.advance).not.toHaveBeenCalled();
    },
  );

  it("caps retained evidence size", async () => {
    const result = await scrollStorePage(driverFor([observation()]), {
      ...STORE_SCROLL_POLICY,
      maxBytes: 1,
    });
    expect(result.proof.ended).toBe("capped");
  });

  it("retains terminal HTML after the load-more control disappears", async () => {
    const driver = driverFor([
      observation({ more: true, ready: true, html: "<html>before</html>" }),
      observation({ ready: true, html: "<html>after</html>" }),
    ]);
    const result = await scrollStorePage(driver, STORE_SCROLL_POLICY);
    expect(result.snapshots.map((snapshot) => snapshot.html)).toEqual([
      "<html>before</html>",
      "<html>after</html>",
    ]);
  });

  it("retains a changed final URL even if it displays the same product identities", async () => {
    const driver = driverFor([observation(), observation({ url: "https://example.com/redirect" })]);
    const result = await scrollStorePage(driver, STORE_SCROLL_POLICY);
    expect(result.snapshots.at(-1)?.url).toBe("https://example.com/redirect");
  });

  it("propagates driver failures and cancellation without another action", async () => {
    const error = new DOMException("cancelled", "AbortError");
    const driver = driverFor([observation()]);
    driver.advance.mockRejectedValue(error);
    await expect(scrollStorePage(driver, STORE_SCROLL_POLICY)).rejects.toBe(error);
    expect(driver.snapshot).toHaveBeenCalledOnce();
  });
});
