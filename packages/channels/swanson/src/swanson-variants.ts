import {
  SwansonRenderedProductSchema,
  type SwansonRenderedProduct,
} from "@crawl-automation/v3-contracts";
import { swansonProductAddress } from "./swanson-address.js";
import { swansonErrors } from "./swanson-errors.js";

export interface SwansonChoice {
  url: string;
  handle: string;
  variantId: string;
  label: string;
  available: boolean;
}

type Picker = NonNullable<SwansonRenderedProduct["variantPicker"]>;

function selectedVariant(page: SwansonRenderedProduct): string {
  const form = page.selectedForms[0];
  const variantId = form?.variantIds[0];
  if (page.selectedForms.length !== 1 || form?.variantIds.length !== 1 || !variantId) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  return variantId;
}

/** Each option links its own product page; the stored choice is that page plus the option's variant ID. */
function choicesOf(picker: Picker): SwansonChoice[] {
  const seen = new Set<string>();
  const choices = picker.options.map((option) => {
    const address = swansonProductAddress(option.url);
    const plainPage = !address.url.hash && !address.url.search;
    if (
      !plainPage ||
      address.url.pathname !== `/p/${address.handle}` ||
      seen.has(option.variantId)
    ) {
      throw swansonErrors.create("SWANSON.VARIANT_CONFLICT");
    }
    // The storefront's own selection navigates to the connected URL plus the variant ID; the bare connected path
    // can render a non-product page on a fresh navigation.
    address.url.searchParams.set("variant", option.variantId);
    seen.add(option.variantId);
    const { label, available } = option;
    return {
      url: address.url.href,
      handle: address.handle,
      variantId: option.variantId,
      label,
      available,
    };
  });
  if (new Set(choices.map((choice) => choice.url)).size !== choices.length) {
    throw swansonErrors.create("SWANSON.VARIANT_CONFLICT");
  }
  return choices;
}

/** The picker's one selected option must be this page's own selected variant. */
function checkSelection(picker: Picker, current: { handle: string; variantId: string }): void {
  if (picker.unmapped || new Set(picker.options.map((option) => option.group)).size !== 1) {
    throw swansonErrors.create("SWANSON.VARIANT_OPTIONS_UNVERIFIED");
  }
  const selected = picker.options.filter((option) => option.selected);
  const chosen = selected[0];
  const sameProduct = chosen && swansonProductAddress(chosen.url).handle === current.handle;
  if (selected.length !== 1 || chosen?.variantId !== current.variantId || !sameProduct) {
    throw swansonErrors.create("SWANSON.VARIANT_CONFLICT");
  }
}

/**
 * The sizes/flavours a Swanson page offers: only explicit, directly linked choices. Never synthesises combinations
 * or copies the selected product's ID or gallery to its connected products.
 */
export function swansonVariantChoices(raw: unknown) {
  const page = SwansonRenderedProductSchema.parse(raw);
  const current = swansonProductAddress(page.canonicalUrl);
  const variantId = selectedVariant(page);
  const picker = page.variantPicker;
  if (!picker || picker.options.length === 0) {
    if (picker?.unmapped) {
      throw swansonErrors.create("SWANSON.VARIANT_OPTIONS_UNVERIFIED");
    }
    const only = {
      url: page.url,
      handle: current.handle,
      variantId,
      label: page.title,
      available: true,
    };
    return { coverage: "selected-only" as const, choices: [only] };
  }
  checkSelection(picker, { handle: current.handle, variantId });
  return { coverage: "declared-options" as const, choices: choicesOf(picker) };
}
