import {
  completeFacts,
  string,
  type CommerceEvidence,
  type FetchedPage,
  type JsonObject,
} from "@crawl-automation/channels-core";
import type { ChannelProductEvidence } from "@crawl-automation/v3-contracts";
import { parseHTML } from "linkedom";
import { costcoStructured } from "./identity.js";
import { costcoEvidence } from "./evidence.js";
import { costcoCommerce, costcoPrices, type CostcoPrice } from "./commerce.js";
import { verifyCostcoStore, type CostcoStore } from "./store.js";
import { costcoChildren, type CostcoChild, type CostcoChildren } from "./children.js";
import { costcoProductAddress } from "./address.js";
import { costcoErrors } from "./errors.js";

export interface CostcoProduct {
  evidence: ChannelProductEvidence;
  /** The page's own children; one entry for an ordinary page. */
  children: CostcoChildren;
  /** The page address without any child fragment. */
  pageUrl: string;
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
  const children = costcoChildren(document, listingId);
  const child = requestedChild(page, children);
  const otherChild = !!child && child.itemNumber !== children.selected;
  const itemNumber = child?.itemNumber ?? pageItemNumber(document, product);
  const prices = otherChild ? [] : costcoPrices(document, listingId);
  const childUrl = child ? `${url}#item=${child.itemNumber}` : url;
  const evidence = costcoEvidence(document, { product, url: childUrl, listingId, child });
  return {
    evidence,
    children,
    pageUrl: url,
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
      otherChild,
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

/** The child a `#item=` address asks for; it must be one of this page's own children. */
function requestedChild(page: FetchedPage, children: CostcoChildren): CostcoChild | undefined {
  const requested = costcoProductAddress(page.url).variantId;
  if (!requested) {
    return undefined;
  }
  const child = children.children.find((entry) => entry.itemNumber === requested);
  if (!child) {
    throw costcoErrors.create("COSTCO.IDENTITY_UNVERIFIED");
  }
  return child;
}

function pageItemNumber(document: Document, product: JsonObject): string | null {
  const description = document.querySelector('[data-testid="product-description"]')?.textContent;
  return /\bItem\s+(\d+)\b/i.exec(description ?? "")?.[1] ?? string(product.sku);
}
