import { isDeepStrictEqual } from "node:util";
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { readObservedProduct, readObservedField } from "./observed-product.mjs";
import { verifyObservedGallery } from "./observed-gallery.mjs";

/** Copy the model's complete checked contexts; never reconstruct a shorter handoff. */
export async function readPreflightVariantContexts(root) {
  const preflight = JSON.parse(await readFile(join(root, "variant-preflight.json"), "utf8"));
  if (!Array.isArray(preflight.contexts) || !preflight.contexts.length) {
    throw new Error("variant_preflight_contexts_missing");
  }
  const seen = new Set();
  const entries = preflight.contexts.map(entry => {
    const context = entry.context;
    if (entry.passed !== true || !["observed", "mixed"].includes(context?.status)
        || typeof context.variantId !== "string" || !context.variantId
        || typeof context.reason !== "string" || !context.reason.trim()
        || !Array.isArray(context.evidence) || !context.evidence.length
        || seen.has(context.variantId)) {
      throw new Error("variant_preflight_context_invalid");
    }
    seen.add(context.variantId);
    return entry;
  });
  return Promise.all(entries.map(async ({ context, method }) => {
    const path = resolve(root, context.methodPath);
    const local = relative(resolve(root), path);
    if (!local || local.startsWith("..") || isAbsolute(local) || await realpath(path) !== path
        || !isDeepStrictEqual(JSON.parse(await readFile(path, "utf8")), method)) {
      throw new Error("variant_preflight_method_mismatch");
    }
    return context;
  }));
}

/** Persist only the model-selected method, return its real path and the same verified context. */
export async function saveObservedVariant(root, base, context, method) {
  if (typeof context.reason !== "string" || !context.reason.trim()
      || !Array.isArray(context.evidence) || !context.evidence.length) {
    throw new Error("variant_preflight_context_invalid");
  }
  const bytes = JSON.stringify(method, null, 2);
  const key = createHash("sha256").update(JSON.stringify([context.variantId, method])).digest("hex");
  const saved = { ...context, methodPath: `methods/variant-${key}.json` };
  await readObservedVariant(root, base, saved, method);
  await mkdir(join(root, "methods"), { recursive: true });
  const path = join(root, saved.methodPath);
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST" || await readFile(path, "utf8") !== bytes) throw error;
  }
  return { context: saved, method, passed: true };
}

/** The model previews the same source checks that the host repeats after archival. No navigation or writes. */
export async function readObservedVariant(root, base, context, method) {
  if (!["observed", "mixed"].includes(context?.status) || !["variant-state", "website-shared"].includes(context.basis)) {
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
  if (context.basis === "variant-state" && selected === null && !context.selectedState) {
    throw new Error("variant_method_requires_selected_url");
  }
  if (selected !== null && selected !== context.variantId) {
    throw new Error("variant_source_selected_conflict");
  }
  if (context.selectedState) {
    const actual = await readObservedField(root, method, context.selectedState.rule);
    if (String(actual) !== context.variantId || context.selectedState.value !== context.variantId) {
      throw new Error("variant_selected_state_mismatch");
    }
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
  if (context.status === "mixed") {
    const urls = (base.gallery ?? []).map(image => image.url);
    if (context.basis !== "variant-state" || !urls.length
      || context.galleryUrls?.length !== urls.length
      || new Set(context.galleryUrls).size !== urls.length
      || context.galleryUrls.some(url => !urls.includes(url))) {
      throw new Error("variant_mixed_gallery_incomplete");
    }
  } else {
    verifyObservedGallery(base, context);
  }
  return observed;
}
