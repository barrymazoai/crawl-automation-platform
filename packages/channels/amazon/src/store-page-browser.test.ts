import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { AmazonStorePages } from "./store-page-browser.js";
import { storeHtml, storeHome } from "./testing/store-fakes.js";

function fakePage(html: string) {
  const document = parseHTML(html).document;
  const context = {
    document,
    URL,
    TextEncoder,
    location: { href: storeHome },
    performance: { getEntriesByType: () => [{ responseStatus: 200 }] },
    window: { scrollY: 0, innerHeight: 1000, scrollBy: () => undefined },
  };
  Object.defineProperty(document.documentElement, "scrollHeight", { value: 1000 });
  for (const element of document.querySelectorAll("button, a")) {
    Object.defineProperty(element, "getClientRects", { value: () => [1] });
  }
  const page = {
    goto: async () => undefined,
    waitForSelector: async () => undefined,
    waitForTimeout: async () => undefined,
    click: vi.fn(async () => {
      document.querySelector("button")?.remove();
    }),
    evaluate: async (callback: (...args: unknown[]) => unknown, argument: unknown) =>
      runInNewContext(`(${callback.toString()})(argument)`, { ...context, argument }),
  };
  const browser = {
    round: async (body: string, params: object) =>
      runInNewContext(`(async () => { ${body} })()`, { page, params, TextEncoder }),
  };
  return { page, browser };
}

describe("Store page script with Ego-shaped fake driver", () => {
  it("executes the actual serialized DOM/scroll functions and returns raw originals and proof", async () => {
    const { browser } = fakePage(storeHtml());
    const result = await new AmazonStorePages(browser).read(
      storeHome,
      new AbortController().signal,
    );
    expect(result.proof).toMatchObject({ ended: "stable", stableRounds: 3 });
    expect(result.snapshots[0]?.html).toContain("ProductGridItem__itemOuter__test");
    expect(result.snapshots[0]?.asins).toEqual(["B000000001"]);
  });

  it("clicks a sibling load-more button through the SDK and archives unmarked HTML", async () => {
    const { browser, page } = fakePage(
      storeHtml().replace("</body>", "<button>Load more</button></body>"),
    );
    const result = await new AmazonStorePages(browser).read(
      storeHome,
      new AbortController().signal,
    );
    expect(page.click).toHaveBeenCalledOnce();
    expect(result.proof.ended).toBe("stable");
    expect(result.snapshots[0]?.html).toContain("Load more");
    expect(result.snapshots.at(-1)?.html).not.toContain("Load more");
    expect(
      result.snapshots.every((snapshot) => !snapshot.html.includes("data-crawlv3-store-more")),
    ).toBe(true);
  });

  it("treats a disabled load-more button as still loading, never exhaustion", async () => {
    const { browser, page } = fakePage(
      storeHtml().replace("</body>", "<button disabled>Show more</button></body>"),
    );
    const result = await new AmazonStorePages(browser).read(
      storeHome,
      new AbortController().signal,
    );
    expect(page.click).not.toHaveBeenCalled();
    expect(result.proof.ended).toBe("capped");
  });
});
