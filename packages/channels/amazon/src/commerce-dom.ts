import { hidden, textOf, type AmazonElement } from "./dom.js";

/** Text from a shown region must also exclude its hidden descendant templates. */
export function commerceVisibleText(element: AmazonElement | null): string {
  if (!element) {
    return "";
  }
  const copy = element.cloneNode(true) as AmazonElement;
  for (const child of copy.querySelectorAll(
    'script, style, noscript, template, [hidden], .aok-hidden, [style*="display:none"], ' +
      '[style*="display: none"], [style*="visibility:hidden"], [style*="visibility: hidden"]',
  )) {
    child.remove();
  }
  return textOf(copy);
}

/** Static evidence only: hidden templates and recommendation regions cannot supply an offer. */
export function commerceElements(root: AmazonElement, selector: string): AmazonElement[] {
  return [...root.querySelectorAll(selector)].filter(
    (element) =>
      !hidden(element) &&
      !element.closest(
        'template, noscript, [style*="visibility:hidden"], ' +
          '[style*="visibility: hidden"], #sims-consolidated-1_feature_div, ' +
          '[id^="sims-"], #recommendations, [data-component-type="sp-sponsored-result"]',
      ),
  );
}

export function uniqueCommerce(values: (string | null | undefined)[]): string | null {
  const unique = [...new Set(values.map((value) => value?.trim()).filter(Boolean))];
  const value = unique[0];
  return unique.length === 1 && value && value.length <= 4000 ? value : null;
}

export function commerceText(root: AmazonElement, selector: string): string | null {
  return uniqueCommerce(commerceElements(root, selector).map(commerceVisibleText));
}

export function locationText(root: AmazonElement): string | null {
  const location = root.ownerDocument?.querySelector("#nav-global-location-popover-link");
  return location && !hidden(location)
    ? commerceVisibleText(location).slice(0, 4000) || null
    : null;
}

export function selectedOffer(root: AmazonElement): AmazonElement | null {
  const active = commerceElements(root, "#buyBoxAccordion .a-accordion-active");
  if (active.length === 1) {
    return active[0] ?? null;
  }
  const boxes = commerceElements(root, "#buybox");
  return !active.length && !commerceElements(root, "#buyBoxAccordion").length && boxes.length === 1
    ? (boxes[0] ?? null)
    : null;
}
