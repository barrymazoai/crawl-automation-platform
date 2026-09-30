import { z } from "zod";
import { appErrors } from "../errors.js";

export const ProductListSchema = z.strictObject({
  sourceId: z.string().max(200).optional(),
  listingId: z.string().max(200).optional(),
  /** The previous page's `nextCursor`, to continue after it. */
  before: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ProductList = z.infer<typeof ProductListSchema>;

export interface CollectedProduct {
  operationId: string;
  sourceId: string;
  listingId: string;
  variantId: string | null;
  collectedAt: string;
  formulaRows: number;
  otherIngredients: number;
  warningCodes: string[];
}

/** One collected product with its full stored record: formula, ingredients, assembly and evidence references. */
export interface ProductDetail extends CollectedProduct {
  record: Record<string, unknown>;
}

export interface ProductPage {
  items: CollectedProduct[];
  nextCursor: string | null;
}

export interface ProductStore {
  list(query: ProductList): Promise<ProductPage>;
  get(operationId: string): Promise<ProductDetail | null>;
}

/** Collected products, newest first by collection time. */
export class ProductService {
  constructor(private readonly deps: { products: ProductStore }) {}

  list(query: ProductList): Promise<ProductPage> {
    return this.deps.products.list(query);
  }

  async get(operationId: string): Promise<ProductDetail> {
    const product = await this.deps.products.get(operationId);
    if (!product) {
      throw appErrors.create("PRODUCT.NOT_FOUND", { details: { operationId } });
    }
    return product;
  }
}
