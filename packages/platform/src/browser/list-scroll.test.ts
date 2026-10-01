import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { BrowserPageSchema } from "./ego-pages.js";
import { LIST_SCROLL_BODY } from "./list-scroll-script.js";
import type { ListScroll } from "./list-scroll.js";

/** Execute the real round body with only the browser I/O replaced; no live browser or provider. */
async function scrollList(
  states: string[][],
  options: Partial<ListScroll> = {},
  scenario: {
    below?: boolean;
    noMore?: boolean;
    waitFailure?: Error;
    aria?: string;
    disabled?: boolean;
  } = {},
) {
  let index = 0;
  let marked = false;
  let pressed = false;
  let buttonTop = scenario.below ? 1200 : 20;
  const actions: string[] = [];
  const rect = { x: 10, y: 20, width: 100, height: 100, top: 20, bottom: 120 };
  const button = {
    offsetParent: {},
    textContent: scenario.aria ? "" : "Load More",
    disabled: scenario.disabled,
    getAttribute: (name: string) => (name === "aria-label" ? scenario.aria : null),
    setAttribute: () => {
      marked = true;
    },
    removeAttribute: () => {
      marked = false;
    },
    getBoundingClientRect: () => ({ ...rect, top: buttonTop, bottom: buttonTop + 100 }),
    click: () => {
      actions.push("click");
      pressed = true;
    },
  };
  const links = () =>
    (states[index] ?? []).map((href) => ({
      getAttribute: () => href,
      outerHTML: `<a href="${href}">Product</a>`,
      getBoundingClientRect: () => rect,
    }));
  const context = {
    URL,
    location: { href: "https://example.com/list" },
    innerWidth: 1000,
    innerHeight: 800,
    window: { scrollTo: () => actions.push("jump") },
    document: {
      body: button,
      documentElement: { scrollHeight: 2000 },
      querySelector: (selector: string) => (selector === "main" || marked ? button : null),
      querySelectorAll: (selector: string) => {
        if (selector === "a.items") {
          return links();
        }
        if (selector === (options.moreSelector ?? "button, a[role=button]")) {
          return !scenario.noMore && index < states.length - 1 ? [button] : [];
        }
        return marked ? [button] : [];
      },
    },
  };
  const evaluate = async (callback: (...args: never[]) => unknown, argument?: unknown) =>
    runInNewContext(`(${callback.toString()})(argument)`, { ...context, argument });
  const waits: number[] = [];
  const page = {
    evaluate,
    waitForFunction: vi.fn(async () => {
      if (scenario.waitFailure) {
        throw scenario.waitFailure;
      }
    }),
    waitForTimeout: async (milliseconds: number) => {
      waits.push(milliseconds);
      if (milliseconds === 10 && (!options.pressDelayMs || pressed)) {
        index = Math.min(index + 1, states.length - 1);
        pressed = false;
      }
    },
    mouse: {
      move: async () => {
        actions.push("move");
      },
      wheel: async () => {
        actions.push("wheel");
        buttonTop -= 400;
      },
    },
  };
  const read = {
    scroll: {
      itemSelector: "a.items",
      moreTexts: ["load more"],
      maxRounds: 10,
      stableRounds: 2,
      settleMs: 10,
      ...options,
    },
  };
  const result = await runInNewContext(`(async () => { ${LIST_SCROLL_BODY}\nreturn scroll; })()`, {
    page,
    read,
    URL,
  });
  return { result, actions, waits };
}

it.each([
  { name: "shrink", next: ["/a"], missing: 1 },
  { name: "replace at equal count", next: ["/c", "/d"], missing: 2 },
  { name: "replace at larger count", next: ["/a", "/c", "/d"], missing: 1 },
  { name: "empty", next: [], missing: 2 },
])(
  "stops on $name and retains every seen identity and original fragment",
  async ({ next, missing }) => {
    const { result } = await scrollList([["/a?ref=1", "/b"], next]);
    expect(result).toMatchObject({
      ended: "broken",
      rounds: 1,
      missingCount: missing,
      finalCount: next.length,
    });
    expect(result.observedItems).toEqual(
      expect.arrayContaining([
        { href: "https://example.com/a", html: '<a href="/a?ref=1">Product</a>' },
        { href: "https://example.com/b", html: '<a href="/b">Product</a>' },
      ]),
    );
  },
);

it("ends stable after normal growth; changing queries never looks like replacement", async () => {
  const { result } = await scrollList([["/a?ref=1"], ["/a?ref=2", "/b"]]);
  expect(result).toEqual({
    ended: "stable",
    rounds: 3,
    seenCount: 2,
    finalCount: 2,
    missingCount: 0,
  });
});

it("does not mark an initially empty list broken", async () => {
  expect((await scrollList([[]])).result.ended).toBe("stable");
});

it("paces presses within the configured range and wheels instead of jumping", async () => {
  const { actions, waits } = await scrollList(
    [["/a"], ["/a", "/b"]],
    {
      pressDelayMs: { min: 4000, max: 8000 },
    },
    { below: true },
  );
  expect(actions.indexOf("move")).toBeLessThan(actions.indexOf("click"));
  expect(actions).toContain("wheel");
  expect(actions.indexOf("wheel")).toBeLessThan(actions.indexOf("click"));
  expect(actions).not.toContain("jump");
  const delays = waits.filter((milliseconds) => milliseconds !== 10);
  expect(delays).toHaveLength(1);
  expect(delays[0]).toBeGreaterThanOrEqual(4000);
  expect(delays[0]).toBeLessThanOrEqual(8000);
});

it("detects disappearance after a scroll without a Load More button", async () => {
  const { result } = await scrollList([["/a", "/b"], []], {}, { noMore: true });
  expect(result).toMatchObject({ ended: "broken", missingCount: 2, finalCount: 0 });
});

it("never silently swallows a failed growth wait other than its expected timeout", async () => {
  const failure = new Error("browser disconnected");
  await expect(scrollList([["/a"], ["/a", "/b"]], {}, { waitFailure: failure })).rejects.toBe(
    failure,
  );
});

it("continues observation after a growth timeout and catches the empty list", async () => {
  // Ego reports a wait timeout as a plain Error (checked 2026-10-01).
  const failure = new Error(
    'page.waitForFunction timed out after 15000ms on page p2; last URL was "x".',
  );
  expect((await scrollList([["/a"], []], {}, { waitFailure: failure })).result.ended).toBe(
    "broken",
  );
});

it.each(["none", "stable", "capped"])("decodes legacy %s records unchanged", (ended) => {
  const page = {
    url: "https://example.com",
    html: "<main/>",
    status: 200,
    ready: true,
    scroll: { rounds: 1, ended },
  };
  expect(BrowserPageSchema.parse(page)).toEqual(page);
});

it("opts into accessible next-page controls without changing legacy selectors", async () => {
  const { result, actions } = await scrollList(
    [["/a"], ["/a", "/b"]],
    {
      moreSelector: "a[rel=next]",
      moreTexts: ["Next page"],
    },
    { aria: "Next page" },
  );
  expect(actions).toContain("click");
  expect(result).toMatchObject({ ended: "stable", seenCount: 2 });
});
it("does not press a disabled next-page control", async () => {
  const { actions } = await scrollList(
    [["/a"], ["/a", "/b"]],
    {
      moreSelector: "a[rel=next]",
      moreTexts: ["Next page"],
    },
    { aria: "Next page", disabled: true },
  );
  expect(actions).not.toContain("click");
});
