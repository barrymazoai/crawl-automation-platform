import { runInNewContext } from "node:vm";
import { BrowserPageSchema, readPageBody, type BrowserRead } from "@crawl-automation/platform";
import { parseHTML } from "linkedom";
import { vi } from "vitest";
import { sectionUrl } from "./product-sections.js";

function drawnElements(document: Document, window: { scrollY: number }) {
  for (const element of document.querySelectorAll("*")) {
    Object.defineProperty(element, "getClientRects", { value: () => [1] });
  }
  for (const image of document.querySelectorAll("img")) {
    Object.defineProperties(image, {
      complete: { value: true, configurable: true },
      naturalWidth: { value: 100, configurable: true },
    });
  }
  const main = document.querySelector("main");
  if (main) {
    Object.defineProperty(main, "getBoundingClientRect", {
      value: () => ({ bottom: 2400 - window.scrollY }),
    });
  }
}

/** Executes the serialized production script against an inert DOM, without opening a browser or networking. */
function testWindow() {
  const window = {
    scrollY: 0,
    innerHeight: 1000,
    navigation: new EventTarget(),
    open: vi.fn(),
    scrollBy: vi.fn((_left: number, top: number) => {
      window.scrollY += top;
    }),
  };
  return window;
}

export function preparationBrowser(html: string) {
  const document = parseHTML(html).document;
  let elapsed = 0;
  const location = { href: sectionUrl };
  const window = testWindow();
  drawnElements(document, window);
  const context = {
    document,
    window,
    location,
    URL,
    performance: { getEntriesByType: () => [{ responseStatus: 200 }] },
  };
  const requireAgent = vi.fn(async () => undefined);
  const page = {
    goto: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async (time: number) => {
      elapsed += time;
    }),
    evaluate: async (callback: (...args: unknown[]) => unknown, argument: unknown) =>
      runInNewContext(`(${callback.toString()})(argument)`, { ...context, argument }),
  };
  const read = vi.fn(async (request: BrowserRead, _signal?: AbortSignal) =>
    BrowserPageSchema.parse(
      await runInNewContext(`(async () => { ${readPageBody(request.preparationScript)} })()`, {
        page,
        params: { read: request },
        requireAgent,
        Date: { now: () => elapsed },
      }),
    ),
  );
  return { provider: "inert-dom", read, page, document, window, location, requireAgent };
}
