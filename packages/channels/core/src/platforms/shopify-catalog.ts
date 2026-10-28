import { z } from "zod";
import { platformPageErrors } from "./errors.js";

const ShopifyCatalogVariant = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  title: z.string().min(1),
  available: z.boolean().optional(),
});

const ShopifyCatalogProduct = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  handle: z.string().regex(/^[^/?#]+$/),
  title: z.string().min(1),
  vendor: z.string().nullable().optional(),
  product_type: z.string().nullable().optional(),
  tags: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .optional(),
  variants: z.array(ShopifyCatalogVariant).min(1),
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
    productType: product.product_type?.trim() || null,
    tags: catalogTags(product.tags),
    variants: product.variants.map((variant) => ({
      id: String(variant.id),
      title: variant.title,
      ...(variant.available === undefined ? {} : { available: variant.available }),
    })),
  }));
}

/** The store's own tags: products.json lists them, a theme's own JSON may join them with commas. */
function catalogTags(tags: string[] | string | null | undefined): string[] {
  const names = typeof tags === "string" ? tags.split(",") : (tags ?? []);
  return [...new Set(names.map((name) => name.trim().slice(0, 200)).filter(Boolean))].slice(0, 20);
}
