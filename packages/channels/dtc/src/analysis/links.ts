import { SiteUrlSchema } from "@crawl-automation/v3-contracts";
import { dtcDocument } from "../product.js";
import type { AnalysisPage } from "./pages.js";

const excluded =
  /(^|\.)(amazon\.[a-z.]+|amzn\.to|target\.com|walmart\.com|iherb\.com|gnc\.com|swansonvitamins\.com|ebay\.[a-z.]+|costco\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|linkedin\.com|pinterest\.com|paypal\.com|stripe\.com|klarna\.com|affirm\.com|afterpay\.com|trustpilot\.com|yotpo\.com|google\.[a-z.]+|doubleclick\.net)$/i;
const brandHeading =
  /^(?:our |the |all |family of |our family of |explore (?:our )?)?brands(?: we own)?$/i;
export function safeLink(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    url.hash = "";
    return SiteUrlSchema.safeParse(url.href).success && !excluded.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function brandPages(page: AnalysisPage): string[] {
  const document = dtcDocument(page.html);
  return [
    ...new Set(
      [...document.querySelectorAll("a[href]")].flatMap((link) => {
        const url = safeLink(link.getAttribute("href") ?? "", page.url);
        return url &&
          brandHeading.test(link.textContent.trim()) &&
          new URL(url).origin === new URL(page.url).origin
          ? [url]
          : [];
      }),
    ),
  ];
}
export function childBrands(page: AnalysisPage, dedicated: boolean) {
  const document = dtcDocument(page.html);
  const scopes: ParentNode[] = dedicated
    ? [document.querySelector("main") ?? document]
    : [...document.querySelectorAll("section, nav, li, [role='menu']")].filter((section) => {
        const title = section.querySelector("h1,h2,h3,h4,summary,a");
        return title !== null && brandHeading.test(title.textContent.trim());
      });
  return scopes.flatMap((scope) =>
    [...scope.querySelectorAll("a[href]")].flatMap((link) => {
      if (
        link.closest(
          "footer, [class*='social'], [class*='review'], [class*='advert'], [rel~='sponsored'], [data-ad]",
        )
      ) {
        return [];
      }
      const url = safeLink(link.getAttribute("href") ?? "", page.url);
      const name = (
        link.textContent.trim() ||
        link.querySelector("img")?.getAttribute("alt") ||
        ""
      ).trim();
      return url && name && new URL(url).origin !== new URL(page.url).origin
        ? [{ name, url, discoveredFrom: { page: page.url, link: url } }]
        : [];
    }),
  );
}
export function catalogLinks(page: AnalysisPage): string[] {
  return [
    ...dtcDocument(page.html).querySelectorAll("nav a[href], header a[href], main a[href]"),
  ].flatMap((link) => {
    const url = safeLink(link.getAttribute("href") ?? "", page.url);
    return url &&
      /^(shop(?: all)?|all products|products|catalog)$/i.test(link.textContent.trim()) &&
      new URL(url).origin === new URL(page.url).origin
      ? [url]
      : [];
  });
}
