import {
  AMAZON_MARKETPLACES,
  type AmazonChannel,
  type LabelCollectedProduct,
} from "@crawl-automation/v3-contracts";
import type { MarketplaceProduct } from "../product-sync/marketplace-model.js";
import type { CrossMarketSide } from "./ports.js";

type Formula = NonNullable<LabelCollectedProduct["formula"]>;
type Row = Formula["columns"][number]["rows"][number];

const text = (field: { text: string } | null | undefined) => field?.text ?? null;
const row = (entry: Row) => ({
  name: entry.name.text,
  amount: text(entry.amount),
  dailyValue: text(entry.dailyValue),
});

/** One storefront's listing as its page and collected label print it, for the model's comparison. */
export function crossMarketSide(
  product: MarketplaceProduct,
  label: LabelCollectedProduct,
): CrossMarketSide {
  return {
    marketplace: AMAZON_MARKETPLACES[product.channel as AmazonChannel].marketplace,
    title: product.product?.title ?? null,
    brand: product.product?.brandRaw ?? product.brand,
    ...printed(label),
  };
}

function printed(label: LabelCollectedProduct) {
  const formula = label.formula;
  const other = label.otherIngredients?.items.map((item) => item.text).join("; ");
  return {
    servingSize: text(formula?.servingSize),
    servingsPerContainer: text(formula?.servingsPerContainer),
    rows: formula?.columns.flatMap((column) => column.rows.map(row)) ?? [],
    otherIngredients: other || null,
  };
}
