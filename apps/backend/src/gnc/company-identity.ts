import { z } from "zod";

export interface GncSearchProductEvidence {
  sku: string;
  brand: string;
  title: string;
  url: string;
}

export interface GncSearchEvidence {
  query: string;
  searchUrl: string;
  returnedQuery: string | null;
  denied: boolean;
  explicitNoResults: boolean;
  resultsNumber: number | null;
  products: GncSearchProductEvidence[];
  brandPageUrls: string[];
}

export interface CompanyIdentityInput {
  companyId: string;
  companyName: string;
  canonicalName: string | null;
  website: string | null;
}

export const companyIdentityVerdictSchema = z.object({
  status: z.enum(["confirmed", "review", "no_match"]),
  gncBrandName: z.string().min(1).nullable(),
  gncBrandPageUrl: z.url().nullable(),
  relationship: z.enum(["exact_brand", "alias", "parent_company", "unverified"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)).max(12),
  reasons: z.array(z.string().min(1)).max(12),
});

export type CompanyIdentityVerdict = z.infer<typeof companyIdentityVerdictSchema>;

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&reg;/gi, "®")
    .replace(/&trade;/gi, "™")
    .replace(/&copy;/gi, "©")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function absoluteGncUrl(value: string) {
  try { return new URL(decodeHtml(value), "https://www.gnc.com").toString(); }
  catch { return null; }
}

export function normalizeCompanyBrand(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[®™©]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/\b(?:incorporated|corporation|company|holdings?|limited|llc|inc|corp|ltd|co)\b\.?/g, " ")
    .replace(/\b(?:official|store|shop)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function companySearchQueries(input: CompanyIdentityInput) {
  const candidates = [input.companyName, input.canonicalName];
  if (input.website) {
    try {
      const hostname = new URL(input.website.match(/^https?:\/\//i) ? input.website : `https://${input.website}`)
        .hostname.replace(/^www\./i, "");
      const label = hostname.split(".")[0]?.replace(/[-_]+/g, " ");
      if (label) candidates.push(label);
    } catch {}
  }
  const seen = new Set<string>();
  return candidates.flatMap((value) => {
    const query = String(value ?? "").replace(/[®™©]/g, "").replace(/\s+/g, " ").trim();
    const key = normalizeCompanyBrand(query);
    if (query.length < 2 || !key || seen.has(key)) return [];
    seen.add(key);
    return [query];
  }).slice(0, 3);
}

export function parseGncSearchHtml(html: string, query: string, searchUrl: string): GncSearchEvidence {
  const denied = /Access to this page has been denied|Pardon Our Interruption|Press\s*&\s*Hold|px-captcha|_pxCaptcha|perimeterx/i.test(html);
  const returnedQueryMatch = html.match(/"searchTerm"\s*:\s*"([^"]*)"/i)
    ?? html.match(/<input[^>]+id="q"[^>]+value="([^"]*)"/i);
  const returnedQuery = returnedQueryMatch ? decodeHtml(returnedQueryMatch[1]!).replace(/\s+/g, " ").trim() : null;
  const explicitNoResults = /class="[^"]*no-search-result-breadcrumb|>\s*No Results\b/i.test(html);
  const resultsMatch = html.match(/"resultsNumber"\s*:\s*(\d+)/i)
    ?? html.match(/class="product-custom-count"[^>]*data-actual-productcount="([\d.]+)"/i);
  const resultsNumber = resultsMatch ? Number.parseInt(resultsMatch[1]!, 10) : null;
  const productStart = html.search(/<ul[^>]+id="search-result-items"/i);
  const productTail = productStart >= 0 ? html.slice(productStart) : "";
  const productEnd = productTail.search(/<div[^>]+class="[^"]*search-results-articles|<div[^>]+id="no-search-results-carousel"|<div[^>]+class="[^"]*related-links-container/i);
  const productRegion = productStart < 0 ? "" : productEnd < 0 ? productTail : productTail.slice(0, productEnd);
  const products = new Map<string, GncSearchProductEvidence>();
  for (const match of productRegion.matchAll(/data-gtmdata="([\s\S]*?)"/gi)) {
    try {
      const value = JSON.parse(decodeHtml(match[1]!)) as Record<string, unknown>;
      const sku = String(value.item_id ?? "").trim();
      const brand = decodeHtml(String(value.item_brand ?? "")).replace(/\s+/g, " ").trim();
      const title = decodeHtml(String(value.item_name ?? value.item_prodname ?? "")).replace(/\s+/g, " ").trim();
      const url = absoluteGncUrl(String(value.item_url ?? value.item_master_url ?? ""));
      if (!sku || !brand || !title || !url || !/gnc\.com$/i.test(new URL(url).hostname)) continue;
      products.set(`${sku}:${url}`, { sku, brand, title, url });
    } catch {}
  }
  const brandPageUrls = new Set<string>();
  const brandKeys = new Set([...products.values()].map((product) => normalizeCompanyBrand(product.brand)));
  const relatedStart = html.search(/<div[^>]+class="[^"]*related-links-container/i);
  const relatedRegion = relatedStart < 0 ? "" : html.slice(relatedStart, relatedStart + 30_000);
  for (const match of relatedRegion.matchAll(/<a[^>]+href="([^"]*\/brands\/[^"?#/]+\/?(?:\?[^"#]*)?)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = decodeHtml(match[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!brandKeys.has(normalizeCompanyBrand(label))) continue;
    const url = absoluteGncUrl(match[1]!);
    if (url) brandPageUrls.add(url.replace(/\?.*$/, ""));
  }
  return {
    query,
    searchUrl,
    returnedQuery,
    denied,
    explicitNoResults,
    resultsNumber,
    products: [...products.values()],
    brandPageUrls: [...brandPageUrls],
  };
}

export function exactIdentityVerdict(input: CompanyIdentityInput, evidence: GncSearchEvidence[]): CompanyIdentityVerdict | null {
  const companyKeys = new Set([input.companyName, input.canonicalName].map(normalizeCompanyBrand).filter(Boolean));
  const products = evidence.flatMap((item) => item.products);
  const brands = [...new Map(products.map((product) => [normalizeCompanyBrand(product.brand), product.brand])).entries()]
    .filter(([key]) => key);
  const matches = brands.filter(([key]) => companyKeys.has(key));
  if (matches.length !== 1 || products.filter((product) => normalizeCompanyBrand(product.brand) === matches[0]![0]).length === 0) return null;
  const brand = matches[0]![1];
  const brandKey = matches[0]![0];
  const sample = products.find((product) => normalizeCompanyBrand(product.brand) === brandKey)!;
  const brandPage = evidence.flatMap((item) => item.brandPageUrls).find((url) => {
    const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1)?.replace(/-/g, " ") ?? "";
    return normalizeCompanyBrand(slug) === brandKey;
  }) ?? null;
  return {
    status: "confirmed",
    gncBrandName: brand,
    gncBrandPageUrl: brandPage,
    relationship: "exact_brand",
    confidence: brandPage ? 1 : 0.98,
    evidence: [
      `GNC structured brand: ${brand}`,
      `GNC product: ${sample.url}`,
      ...(brandPage ? [`GNC brand page: ${brandPage}`] : []),
    ],
    reasons: [],
  };
}

export function buildCompanyIdentityPrompt(input: CompanyIdentityInput, evidence: GncSearchEvidence[]) {
  const compact = evidence.map((item) => ({
    query: item.query,
    resultsNumber: item.resultsNumber,
    brandPageUrls: item.brandPageUrls.slice(0, 10),
    products: item.products.slice(0, 20),
  }));
  return `You are resolving whether GNC search evidence belongs to one Product Staging company.

COMPANY
${JSON.stringify({ name: input.companyName, canonicalName: input.canonicalName, website: input.website }, null, 2)}

GNC SEARCH EVIDENCE
${JSON.stringify(compact, null, 2)}

Rules:
1. Keyword search is discovery only. A keyword hit is never identity proof by itself.
2. Treat the structured GNC item_brand and an official /brands/... page as the strongest GNC evidence.
3. exact_brand is allowed only when the company/brand names are the same after harmless punctuation, trademark, and legal-suffix normalization.
4. alias or parent_company requires corroborating official evidence. You may inspect the company's official website and the supplied GNC URLs. Do not rely on marketplaces, snippets, or unsupported memory.
5. If ownership is not directly supported, return review/unverified. If the search is irrelevant, return no_match/unverified.
6. Never infer identity merely from similar product categories or similar words.
7. Evidence strings must state the concrete source URL or structured field used.

Return one object with one string field named payload. Serialize exactly one JSON object inside payload with:
{
  "status": "confirmed" | "review" | "no_match",
  "gncBrandName": string | null,
  "gncBrandPageUrl": string | null,
  "relationship": "exact_brand" | "alias" | "parent_company" | "unverified",
  "confidence": number from 0 to 1,
  "evidence": string[],
  "reasons": string[]
}`;
}
