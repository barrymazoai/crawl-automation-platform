export function dtcCatalogCoverageTarget(url: string): {
  version: "shopify-all-products/1" | "shopify-collection-products/1";
  endpoint: string;
} | undefined;
export function verifyDtcCatalogCoverage(proof: {
  version: string;
  catalogUrl: string;
  dom: { url: string; links: string[] };
  responses: { url: string; status: number; contentType: string; body: string }[];
}, url: string, entries: { url: string }[]): boolean;
