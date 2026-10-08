import { jsonLdBreadcrumbs } from "@crawl-automation/channels-core";
import { DomUtils, parseDocument } from "htmlparser2";

/** The store's breadcrumb from the retained page's JSON-LD (scripts are read as text, never run). */
export function gncBreadcrumb(html: string): string[] {
  const scripts = DomUtils.findAll(
    (element) => element.name === "script" && element.attribs["type"] === "application/ld+json",
    parseDocument(html).children,
  );
  return jsonLdBreadcrumbs(scripts.map((script) => DomUtils.textContent(script)));
}
