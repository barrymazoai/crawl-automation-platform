/**
 * Marketplaces and retailers: they sell other companies' brands. Never a brand's official website (owner
 * 2026-10-15), and a Supply Smart brand request for one of these sites is not enriched (owner 2026-10-20, KAN-220:
 * GNC is already a company with its own products; the brands it sells are requested by their own websites).
 */
export const RETAIL_SITES = [
  "amazon.com",
  "walmart.com",
  "target.com",
  "ebay.com",
  "iherb.com",
  "vitacost.com",
  "luckyvitamin.com",
  "pipingrock.com",
  "vitaminshoppe.com",
  "cvs.com",
  "walgreens.com",
  "gnc.com",
  "swansonvitamins.com",
  "wholefoodsmarket.com",
  "costco.com",
] as const;

/** The retail site a URL or bare domain belongs to (subdomains included), or undefined. */
export function retailSiteOf(value: string): (typeof RETAIL_SITES)[number] | undefined {
  let host: string;
  try {
    host = new URL(value.includes("://") ? value : `https://${value}`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return undefined;
  }
  return RETAIL_SITES.find((site) => host === site || host.endsWith(`.${site}`));
}
