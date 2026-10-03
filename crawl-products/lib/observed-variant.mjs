import { isDeepStrictEqual } from "node:util";
import { readObservedProduct, readObservedField } from "./observed-product.mjs";

/** The model previews the same source checks that the host repeats after archival. No navigation or writes. */
export async function readObservedVariant(root, base, context, method) {
  if (context?.status !== "observed" || !["variant-state", "website-shared"].includes(context.basis)) {
    throw new Error("variant_observed_context_required");
  }
  if (base.variants.filter(variant => String(variant.variantId) === context.variantId).length !== 1) {
    throw new Error("variant_identity_missing_or_duplicate");
  }
  const observed = await readObservedProduct(root, method);
  const source = new URL(observed.sourceUrl), product = new URL(base.productUrl ?? base.sourceUrl);
  const selected = source.searchParams.get("variant") ?? source.searchParams.get("variation_id");
  if (source.origin !== product.origin || source.pathname !== product.pathname) {
    throw new Error("variant_source_identity_conflict");
  }
  if (context.basis === "variant-state" && selected === null) {
    throw new Error("variant_method_requires_selected_url");
  }
  if (selected !== null && selected !== context.variantId) {
    throw new Error("variant_source_selected_conflict");
  }
  if (!isDeepStrictEqual(observed.variants, base.variants)) {
    throw new Error("variant_inventory_changed");
  }
  if (context.basis === "website-shared") {
    if (!context.sharedScope) throw new Error("variant_shared_scope_statement_required");
    const statement = await readObservedField(root, method, context.sharedScope.rule);
    if (typeof statement !== "string" || statement !== context.sharedScope.text) {
      throw new Error("variant_shared_scope_statement_mismatch");
    }
  }
  return observed;
}
