import { object, parsePageJson, type JsonObject } from "@crawl-automation/channels-core";

/** Decode JSON string chunks only. Never execute page scripts or evaluate Flight references. */
function flightText(document: Document): string {
  return [...document.querySelectorAll("script")]
    .flatMap((script) => {
      const match = /^self\.__next_f\.push\((\[.*\])\);?$/s.exec(script.textContent ?? "");
      const chunk = match?.[1] ? parsePageJson(match[1]) : null;
      return Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === "string"
        ? [chunk[1]]
        : [];
    })
    .join("");
}

/** React element props/children only; no recursive search through recommendation or API data. */
function elementProps(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value[0] !== "$") {
    return value.flatMap(elementProps);
  }
  const props = object(value[3]);
  return props ? [props, ...elementProps(props.children)] : [];
}

/** Costco's inline product/gallery rows may follow a length-prefixed text row on the same line. */
export function costcoPageProps(document: Document): JsonObject[] {
  return flightText(document)
    .split("\n")
    .flatMap((line) => {
      if (!line.includes('"brandfolderAsset":') && !line.includes('"productDetailsData":')) {
        return [];
      }
      const match = /[0-9a-f]+:(\["\$".*)$/.exec(line);
      return match?.[1] ? elementProps(parsePageJson(match[1])) : [];
    });
}

export function costcoPriceData(document: Document, listingId: string): JsonObject | null {
  const details = costcoPageProps(document)
    .map((props) => object(props.productDetailsData))
    .find((data) => object(data?.productData)?.id === listingId);
  return object(object(details?.priceInfo)?.displayPrice);
}
