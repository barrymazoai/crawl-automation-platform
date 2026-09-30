import {
  classifyFamily,
  type ParsedProduct,
  type ProductFamily,
} from "@crawl-automation/channels-core";
import { swansonProductAddress } from "./swanson-address.js";
import type { SwansonRenderedProduct } from "@crawl-automation/v3-contracts";

type Picker = NonNullable<SwansonRenderedProduct["variantPicker"]>;
type Option = Picker["options"][number];

/** The picker is usable evidence only with one option group, every option mapped and exactly one selected. */
function readablePicker(rendered: SwansonRenderedProduct): Picker | null {
  const picker = rendered.variantPicker;
  if (!picker || picker.unmapped > 0 || picker.options.length < 2) {
    return null;
  }
  const groups = new Set(picker.options.map((option) => option.group));
  const selected = picker.options.filter((option) => option.selected);
  return groups.size === 1 && selected.length === 1 ? picker : null;
}

function member(option: Option) {
  const address = swansonProductAddress(option.url);
  return {
    listingId: address.handle,
    variantId: option.variantId,
    url: address.url.href,
    label: option.label,
  };
}

/**
 * The Swanson family as the product page's option picker shows it. On Swanson each size is its own product (its
 * own handle), and the picker links them. Anything the picker does not state clearly means no family: sibling
 * reuse is then simply not attempted.
 */
export function swansonFamily(parsed: ParsedProduct<SwansonRenderedProduct>): ProductFamily | null {
  const picker = readablePicker(parsed.rendered);
  if (!picker) {
    return null;
  }
  const group = picker.options[0]?.group ?? "";
  const selected = picker.options.find((option) => option.selected);
  const others = picker.options.filter((option) => !option.selected);
  if (!selected || others.length === 0) {
    return null;
  }
  const labels = picker.options.map((option) => option.label);
  return {
    differsBy: classifyFamily(group, labels),
    group,
    selectedLabel: selected.label,
    members: others.map(member),
  };
}
