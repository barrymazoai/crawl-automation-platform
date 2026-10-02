import { describe, it, expect, vi } from "vitest";
import { createEgoBrowser } from "./ego-native-browser.mjs";
import { normalizeHarvestPlan } from "./harvest-plan.mjs";

function fixture() {
  let ownership = "agent";
  const page = { targetId: "owned", evaluate: vi.fn(async () => 200), goto: vi.fn(),
    close: vi.fn(), cdp: vi.fn(), click: vi.fn(), events: vi.fn(async () => []) };
  const task = { spaceId: 6, tabs: vi.fn(async () => [{ targetId: "owned", openedBy: "agent" }]) };
  const browser = createEgoBrowser({ task, page, workDir: "/tmp/unused", listTaskSpaces: async () => [{ id: 6, ownership }],
    productUrl: "https://shop.example/products/one" });
  return { page, task, browser, takeOver: () => { ownership = "user"; } };
}

describe("native Ego harvest adapter", () => {
  it("resolves a resumed Page through the host target ID and fresh tab inventory", async () => {
    const { page, task } = fixture();
    task.tabs.mockResolvedValue([{ targetId: "owned", openedBy: "agent", page }]);
    const wrongPage = { goto: vi.fn() };
    const browser = createEgoBrowser({ task, page: wrongPage, targetId: "owned", workDir: "/tmp/unused",
      listTaskSpaces: async () => [{ id: 6, ownership: "agent" }] });
    await browser.tab.goto("https://shop.example/products/one");
    expect(page.goto).toHaveBeenCalledOnce();
    expect(wrongPage.goto).not.toHaveBeenCalled();
  });
  it("preserves the native browser mode and host-selected product", () => {
    const { browser } = fixture();
    expect(normalizeHarvestPlan({ site: { browserMode: "ego-native" } }).site.browserMode).toBe("ego-native");
    expect(browser.productUrl).toBe("https://shop.example/products/one");
  });
  it("reuses the exact host page and leaves closure to the host", async () => {
    const { browser, page } = fixture();
    expect(await browser.tabs.new()).toBe(browser.tab);
    await browser.tab.goto("https://shop.example/products/one");
    expect(page.goto).toHaveBeenCalledOnce();
    await browser.tab.close();
    expect(page.close).not.toHaveBeenCalled();
  });
  it("checks fresh ownership before each operation", async () => {
    const { browser, page, takeOver } = fixture();
    takeOver();
    await expect(browser.tab.goto("https://shop.example")).rejects.toThrow("SOURCE.BROWSER_USER_CONTROL");
    expect(page.goto).not.toHaveBeenCalled();
  });
  it("cannot operate another target or use browser-wide CDP", async () => {
    const { browser, task, page } = fixture();
    const cdp = await browser.tab.capabilities.get("cdp");
    await expect(cdp.send("Target.closeTarget", { targetId: "user" })).rejects.toThrow("SOURCE.TARGET_SCOPE");
    task.tabs.mockResolvedValue([{ targetId: "user", openedBy: "unknown" }]);
    await expect(browser.tab.playwright.evaluate(() => 1)).rejects.toThrow("SOURCE.TARGET_MISSING");
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
