import { pageText } from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";

type StaticWindow = ReturnType<typeof parseHTML>;

function defineGetter(prototype: object, name: string, get: (this: Element) => unknown): void {
  Object.defineProperty(prototype, name, { configurable: true, get });
}

/** Match browser URL properties while leaving malformed attributes for projection validation. */
function absoluteUrl(value: string | null, pageUrl: string): string {
  if (value === null) {
    return "";
  }
  return URL.canParse(value, pageUrl) ? new URL(value, pageUrl).href : value;
}

function resolvePageLinks(window: StaticWindow, pageUrl: string): void {
  const properties: [object, string, string][] = [
    [window.HTMLImageElement.prototype, "src", "src"],
    [window.HTMLImageElement.prototype, "currentSrc", "src"],
    [window.HTMLAnchorElement.prototype, "href", "href"],
    [window.HTMLLinkElement.prototype, "href", "href"],
  ];
  for (const [prototype, property, attribute] of properties) {
    defineGetter(prototype, property, function () {
      return absoluteUrl(this.getAttribute(attribute), pageUrl);
    });
  }
}

function readPageAttributes(window: StaticWindow): void {
  const properties: [object, string][] = [
    [window.HTMLImageElement.prototype, "alt"],
    [window.HTMLMetaElement.prototype, "content"],
    [window.HTMLInputElement.prototype, "value"],
  ];
  for (const [prototype, attribute] of properties) {
    defineGetter(prototype, attribute, function () {
      return this.getAttribute(attribute) ?? "";
    });
  }
  defineGetter(window.HTMLInputElement.prototype, "checked", function () {
    return this.hasAttribute("checked");
  });
}

/** No layout engine: preserve explicit hidden markers and the adapter's shared text conversion. */
function readPageText(window: StaticWindow): void {
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: function (this: Element) {
      return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{}];
    },
  });
  defineGetter(window.HTMLElement.prototype, "innerText", function () {
    return pageText(this.innerHTML);
  });
}

/** The retained HTML alone supplies the DOM; scripts are removed, never executed. */
export function swansonStaticDocument(html: string, pageUrl: string): Document {
  const window = parseHTML(html);
  for (const element of window.document.querySelectorAll("script,style,noscript,template")) {
    element.remove();
  }
  resolvePageLinks(window, pageUrl);
  readPageAttributes(window);
  readPageText(window);
  return window.document;
}
