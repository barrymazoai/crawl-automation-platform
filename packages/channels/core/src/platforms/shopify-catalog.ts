import { z } from "zod";
import { platformPageErrors } from "./errors.js";

const ShopifyCatalogProduct = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  handle: z.string().regex(/^[^/?#]+$/),
  title: z.string().min(1),
  vendor: z.string().nullable().optional(),
});
const ShopifyCatalogPage = z.object({ products: z.array(ShopifyCatalogProduct) });

/** Parse one products.json page body; a channel that retains the browser rendering hands over the <pre> text. */
export function readShopifyCatalogPage(json: string | undefined) {
  if (json === undefined) {
    throw platformPageErrors.create("DTC.CATALOG_JSON_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw platformPageErrors.create("DTC.CATALOG_JSON_INVALID", { cause });
  }
  const result = ShopifyCatalogPage.safeParse(value);
  if (!result.success) {
    throw platformPageErrors.create("DTC.CATALOG_JSON_INVALID", { cause: result.error });
  }
  return result.data.products.map((product) => ({
    productId: String(product.id),
    handle: product.handle,
    title: product.title,
    brandRaw: product.vendor?.trim() || null,
  }));
}
