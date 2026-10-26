import { describe, expect, it, vi } from "vitest";
import { HealthFunctionCleanup, staleLinks } from "./health-function-cleanup.js";
import type { RefreshedHealthFunctions } from "./ledger.js";

const product = (id: string, current: string[], previous: string[]): RefreshedHealthFunctions => ({
  supplySmartProductId: id,
  current,
  previous,
});

describe("staleLinks", () => {
  it("unlinks only names an earlier enrichment sent that no current one sends, ignoring case and spacing", () => {
    const links = [
      { id: "1", name: "support optimal protein synthesis and recovery" },
      { id: "2", name: "Muscle  Recovery" },
      { id: "3", name: "Immune Support" }, // never sent by the crawler: a legacy or manual link
      { id: "4", name: "Energy" },
    ];
    expect(
      staleLinks(
        product(
          "p",
          ["muscle recovery"],
          ["Support optimal protein synthesis and recovery", "Muscle Recovery", "energy"],
        ),
        links,
      ),
    ).toEqual([
      { id: "1", name: "support optimal protein synthesis and recovery" },
      { id: "4", name: "Energy" },
    ]);
  });
});

function setup(
  products: RefreshedHealthFunctions[],
  links: Record<string, { id: string; name: string }[]>,
) {
  const refreshedHealthFunctions = vi.fn(async () => products);
  const list = vi.fn(async (id: string) => links[id] ?? []);
  const unlink = vi.fn(async () => undefined);
  const cleanup = new HealthFunctionCleanup({
    ledger: { refreshedHealthFunctions },
    healthFunctions: { list, unlink },
  });
  return { cleanup, refreshedHealthFunctions, list, unlink };
}

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;

describe("HealthFunctionCleanup", () => {
  it("is a dry run by default and pages with the last product ID", async () => {
    const { cleanup, unlink, refreshedHealthFunctions } = setup(
      [product(ids[0], ["Joint Health"], ["supports healthy joints"]), product(ids[1], [], [])],
      { [ids[0]]: [{ id: "h1", name: "supports healthy joints" }] },
    );
    expect(await cleanup.run({ limit: 2, after: ids[0] })).toEqual({
      dryRun: true,
      checked: 2,
      removable: 1,
      removed: 0,
      examples: [{ productId: ids[0], name: "supports healthy joints" }],
      failure: null,
      next: ids[1],
    });
    expect(refreshedHealthFunctions).toHaveBeenCalledWith({ after: ids[0], limit: 2 });
    expect(unlink).not.toHaveBeenCalled();
  });

  it("unlinks when asked and stops at the first failure", async () => {
    const { cleanup, unlink } = setup([product(ids[0], [], ["a"]), product(ids[1], [], ["b"])], {
      [ids[0]]: [{ id: "h1", name: "a" }],
      [ids[1]]: [{ id: "h2", name: "b" }],
    });
    unlink.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("gateway 500"));
    expect(await cleanup.run({ limit: 5, dryRun: false })).toMatchObject({
      checked: 2,
      removable: 2,
      removed: 1,
      failure: { productId: ids[1], message: "gateway 500" },
      next: null,
    });
    expect(unlink).toHaveBeenCalledWith(ids[0], "h1", expect.any(AbortSignal));
  });
});
