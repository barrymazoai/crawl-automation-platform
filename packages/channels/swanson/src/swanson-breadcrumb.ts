import { jsonLdBreadcrumbs } from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";

/** The store's breadcrumb from the retained page's JSON-LD (scripts are read as text, never run). */
export function swansonBreadcrumb(html: string): string[] {
  const { document } = parseHTML(html);
  return jsonLdBreadcrumbs(
    [...document.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => script.textContent ?? "",
    ),
  );
}
