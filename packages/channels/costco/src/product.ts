import {
  completeFacts,
  string,
  type CommerceEvidence,
  type FetchedPage,
} from "@crawl-automation/channels-core";
import type { ChannelProductEvidence } from "@crawl-automation/v3-contracts";
import { parseHTML } from "linkedom";
import { costcoStructured } from "./identity.js";
import { costcoEvidence } from "./evidence.js";
import { costcoCommerce, costcoPrices, type CostcoPrice } from "./commerce.js";
import { verifyCostcoStore, type CostcoStore } from "./store.js";

export interface CostcoProduct {
  evidence: ChannelProductEvidence;
  commerce: CommerceEvidence;
  itemNumber: string | null;
  warehouseId: string;
  warehouseVerified: boolean;
  prices: CostcoPrice[];
}

/** Parse only the selected product; the original HTML has already been verified in R2. */
export function parseCostcoProduct(page: FetchedPage, store: CostcoStore): CostcoProduct {
  const { document } = parseHTML(page.html);
  const { product, url, listingId } = costcoStructured(document);
  const warehouse = verifyCostcoStore(page.html, store);
  const description = document.querySelector('[data-testid="product-description"]')?.textContent;
  const itemNumber = /\bItem\s+(\d+)\b/i.exec(description ?? "")?.[1] ?? string(product.sku);
  const prices = costcoPrices(document, listingId);
  const evidence = costcoEvidence(document, { product, url, listingId });
  return {
    evidence,
    itemNumber,
    warehouseId: store.storeId,
    warehouseVerified: warehouse.verified,
    prices,
    commerce: costcoCommerce({
      product,
      listingId,
      itemNumber,
      prices,
      store,
      storeVerified: warehouse.verified,
    }),
  };
}

export function costcoFacts(evidence: ChannelProductEvidence) {
  const html = evidence.factsCandidates
    .filter((candidate) => candidate.scope === "selected-product")
    .map((candidate) => candidate.html)
    .join("\n");
  return completeFacts(html || null);
}
