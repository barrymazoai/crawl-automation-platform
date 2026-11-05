import type { PurchaseConditions } from "@crawl-automation/v3-contracts";
import { commerceElements, commerceText, uniqueCommerce } from "./commerce-dom.js";
import type { AmazonElement } from "./dom.js";
import { commerceVisibleText as textOf } from "./commerce-dom.js";

function labelled(offer: AmazonElement, labels: string[]): string | null {
  const values = commerceElements(
    offer,
    "[tabular-attribute-name], .tabular-buybox-text, .offer-display-feature-label",
  );
  return uniqueCommerce(
    values
      .filter((element) =>
        labels.includes(element.getAttribute("tabular-attribute-name") ?? textOf(element)),
      )
      .map((element) => {
        const value = element.nextElementSibling;
        return value
          ? (commerceText(value, ".offer-display-feature-text-message") ?? textOf(value))
          : null;
      }),
  );
}

/** Seller URLs keep only the public seller ID, never hidden offer or session parameters. */
export function purchaseSeller(
  offer: AmazonElement,
  out: PurchaseConditions,
  origin: string,
): void {
  const links = commerceElements(offer, "#sellerProfileTriggerId");
  const combined = labelled(offer, ["Shipper / Seller", "Ships from and sold by"]);
  out.seller.name = selectedSeller(offer);
  out.shipsFrom = uniqueCommerce([labelled(offer, ["Ships from"]), combined]);
  const urls = links
    .filter((link) => textOf(link) === out.seller.name)
    .flatMap((link) => sellerUrl(link, origin));
  out.seller.id = uniqueCommerce(urls.map((item) => item.id));
  out.seller.url = out.seller.id ? uniqueCommerce(urls.map((item) => item.url)) : null;
  if (out.seller.name) {
    out.evidence.push({
      field: "seller",
      selector: "#sellerProfileTriggerId, .tabular-buybox-text, .offer-display-feature-label",
      text: out.seller.name,
    });
  }
}

export function selectedSeller(offer: AmazonElement): string | null {
  const links = commerceElements(offer, "#sellerProfileTriggerId");
  return links.length
    ? uniqueCommerce(links.map(textOf))
    : uniqueCommerce([
        labelled(offer, ["Sold by"]),
        labelled(offer, ["Shipper / Seller", "Ships from and sold by"]),
      ]);
}

function sellerUrl(link: AmazonElement, origin: string): { id: string; url: string }[] {
  const url = URL.parse(link.getAttribute("href") ?? "", origin);
  if (!url || url.origin !== origin || url.username || url.password) {
    return [];
  }
  const id = url.searchParams.get("seller") ?? url.searchParams.get("me");
  return id && /^[A-Z0-9]+$/.test(id)
    ? [{ id, url: `${url.origin}${url.pathname}?seller=${id}` }]
    : [];
}
