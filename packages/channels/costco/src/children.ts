import { object, string, type JsonObject } from "@crawl-automation/channels-core";
import { costcoPageProps } from "./page-data.js";

/** One sellable item of a Costco page: its warehouse item number, own title and defining options. */
export interface CostcoChild {
  itemNumber: string;
  title: string | null;
  options: string[];
}

export interface CostcoChildren {
  /** The child the server HTML selects; its price is the only one the page data carries. */
  selected: string | null;
  children: CostcoChild[];
}

const ITEM_NUMBER = /^\d{4,12}$/;

/**
 * The page's own `productData.childCatalogData`, children of this online ID only (owner 2026-10-05). Linked sibling
 * pages that appear elsewhere in the page data are separate products found by brand scans.
 */
export function costcoChildren(document: Document, listingId: string): CostcoChildren {
  const details = costcoPageProps(document)
    .map((props) => object(props.productDetailsData))
    .find((data) => object(data?.productData)?.id === listingId);
  const data = object(details?.productData);
  const raw = Array.isArray(data?.childCatalogData) ? data.childCatalogData : [];
  const children = raw.flatMap((entry) => {
    const child = object(entry);
    const itemNumber = string(child?.id);
    const parents = Array.isArray(child?.parentId) ? child.parentId : [];
    if (!child || !itemNumber || !ITEM_NUMBER.test(itemNumber) || child.itemType !== "Item") {
      return [];
    }
    return parents.includes(listingId)
      ? [{ itemNumber, title: childTitle(child), options: childOptions(child) }]
      : [];
  });
  const selected = string(details?.selectedChildItemNumber);
  return {
    selected: selected && children.some((child) => child.itemNumber === selected) ? selected : null,
    children,
  };
}

function childTitle(child: JsonObject): string | null {
  const descriptions = Array.isArray(child.descriptions) ? child.descriptions : [];
  for (const entry of descriptions) {
    const text = string(object(object(entry)?.object)?.shortDescription);
    if (text) {
      return text.replace(/^\uFEFF/u, "").trim();
    }
  }
  return null;
}

function childOptions(child: JsonObject): string[] {
  const attributes = Array.isArray(child.productAttributes) ? child.productAttributes : [];
  return attributes.flatMap((attribute) => {
    const list = object(attribute)?.object;
    return (Array.isArray(list) ? list : []).flatMap((raw) => {
      const option = object(raw);
      const key = string(option?.key);
      const value = string(option?.value);
      return option?.type === "defining" && key && value ? [`${key}: ${value}`] : [];
    });
  });
}
