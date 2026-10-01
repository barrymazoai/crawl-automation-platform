import type { PurchaseConditions } from "@crawl-automation/v3-contracts";
import { commerceElements, commerceText } from "./commerce-dom.js";
import type { AmazonElement } from "./dom.js";

function addOption(
  out: PurchaseConditions,
  option: { name: string | null; value: string | null; selector: string },
): void {
  const { name, value, selector } = option;
  if (
    !name ||
    !value ||
    out.selectedOptions.length >= 20 ||
    out.selectedOptions.some((item) => item.name === name && item.value === value)
  ) {
    return;
  }
  out.selectedOptions.push({ name, value });
  out.evidence.push({
    field: "selectedOptions",
    selector,
    text: `${name} ${value}`.slice(0, 4000),
  });
}

export function purchaseOptions(root: AmazonElement, out: PurchaseConditions): void {
  for (const element of commerceElements(root, '[id^="variation_"]')) {
    addOption(out, {
      name: commerceText(element, ".a-form-label"),
      value: commerceText(element, ".selection"),
      selector: `#${element.id}`,
    });
  }
  for (const element of commerceElements(root, '[id^="inline-twister-row-"]')) {
    const selected = commerceElements(element, '[role="radio"][aria-checked="true"]');
    const swatch = selected.length === 1 ? selected[0]?.closest("li[data-asin]") : null;
    const value = commerceText(element, '[id^="inline-twister-expanded-dimension-text-"]');
    const asin = root.querySelector("#ASIN")?.getAttribute("value");
    if (
      !swatch ||
      swatch.getAttribute("data-asin") !== asin ||
      commerceText(swatch, ".swatch-title-text") !== value
    ) {
      out.warnings.push("PURCHASE.OPTION_SELECTION_UNKNOWN");
      continue;
    }
    addOption(out, {
      name: commerceText(element, '[id^="inline-twister-dim-title-"] .a-color-secondary'),
      value,
      selector: `#${element.id}`,
    });
  }
}
