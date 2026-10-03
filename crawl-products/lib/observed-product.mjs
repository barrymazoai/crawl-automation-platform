import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseHTML } from "linkedom";
import { htmlToText } from "./engine.mjs";
import { normalizePlatformVariants } from "./platform-variants.mjs";
import { nativeAvailability } from "./native-availability.mjs";

const fail = reason => { throw new Error(`DTC.OBSERVED_METHOD:${reason}`); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Execute only the exact sources/locations chosen by the model. No discovery or fallback. */
export async function readObservedProduct(root, method) {
  const sources = await readSources(root, method);
  const requested = new URL(method.productUrl);
  return productFromSources(method, requested, sources);
}

/** Replay one model-observed proof location using the same immutable source checks. */
export async function readObservedField(root, method, rule) {
  return readField(rule, await readSources(root, method));
}

/** Inspect only the model-selected node; never discover or expand page sections. */
export async function inspectObservedField(root, method, rule) {
  const sources = await readSources(root, method);
  const value = readField(rule, sources);
  let collapsed = false;
  if (sources[rule.source].kind === "dom") {
    let node = sources[rule.source].value.querySelector(rule.selector);
    while (node) {
      if (node.localName === "details" && !node.hasAttribute("open")) collapsed = true;
      node = node.parentElement;
    }
  }
  return { value, collapsed };
}

async function readSources(root, method) {
  if (method?.codec !== "observed-product/1" || !Array.isArray(method.sources)
    || !method.sources.length || !method.fields || typeof method.fields !== "object") fail("method_required");
  const requested = new URL(method.productUrl);
  return Promise.all(method.sources.map(async source => {
    const url = new URL(source.url);
    const expectedPath = requested.pathname.replace(/\/$/, "");
    if (url.origin !== requested.origin || ![expectedPath, `${expectedPath}.json`].includes(url.pathname.replace(/\/$/, ""))) fail("source_identity");
    const variant = requested.searchParams.get("variant") || requested.searchParams.get("variation_id");
    if (source.kind === "dom" && variant && variant !== (url.searchParams.get("variant") || url.searchParams.get("variation_id"))) fail("source_variant");
    const file = resolve(root, source.path), local = relative(resolve(root), file);
    if (!local || local.startsWith("..") || isAbsolute(local) || await realpath(file) !== file) fail("source_path");
    const bytes = await readFile(file);
    if (bytes.length > 32 * 1024 * 1024 || hash(bytes) !== source.sha256) fail("source_hash");
    if (!["dom", "json"].includes(source.kind)) fail("source_kind");
    return { ...source, text: bytes.toString(), value: source.kind === "json" ? JSON.parse(bytes) : parseHTML(bytes.toString()).document };
  }));
}

function productFromSources(method, requested, sources) {
  const fields = Object.fromEntries(Object.entries(method.fields).map(([name, rule]) => [name, readField(rule, sources)]));
  const platform = method.platform ? readShopify(method, sources) : null;
  if (!fields.title || !fields.brand) fail("title_or_brand_missing");
  const variants = platform?.variants ?? (method.variantMappings ?? []).map(mapping =>
    Object.fromEntries(Object.entries(mapping).map(([name, rule]) => [name, readField(rule, sources)])));
  if (variants.length > 1 && !requested.searchParams.has("variant") && !requested.searchParams.has("variation_id")
    && (Object.hasOwn(fields, "price") || Object.hasOwn(fields, "sku"))) fail("base_variant_field");
  if (platform?.flags.length) fail(platform.flags.join(","));
  const selectedId = requested.searchParams.get("variant") || requested.searchParams.get("variation_id");
  if (selectedId) {
    const selected = variants.find(variant => String(variant.variantId) === selectedId);
    if (!selected) fail("selected_variant_missing");
    for (const name of ["sku", "price"]) {
      if (Object.hasOwn(fields, name) && selected[name] != null && String(fields[name]) !== String(selected[name])) fail("selected_variant_field");
    }
  }
  return { sourceUrl: method.productUrl, fields, variants, fieldEvidence: method };
}

function readField(rule, sources) {
  const source = sources[rule?.source];
  if (!source) fail("field_source");
  let value;
  if (source.kind === "json") {
    value = pointer(source.value, rule.pointer);
  } else {
    if (typeof rule.selector !== "string" || !rule.selector.trim()) fail("selector_required");
    let matches;
    try { matches = source.value.querySelectorAll(rule.selector); } catch { fail("invalid_selector"); }
    if (matches.length !== 1) fail("selector_not_unique");
    const node = matches[0];
    value = rule.attribute ? node.getAttribute(rule.attribute)
      : rule.format === "html" ? node.outerHTML : htmlToText(node.innerHTML).trim();
  }
  if (value === undefined || value === null || value === "") fail("field_absent");
  if (rule.format === "html-text") value = htmlToText(String(value)).trim();
  else if (rule.format && !["raw", "html"].includes(rule.format)) fail("field_format");
  if (rule.format === "html" && (rule.attribute || typeof value !== "string")) fail("html_field_required");
  return value;
}

function pointer(value, location) {
  if (typeof location !== "string" || !location.startsWith("/")) fail("json_pointer");
  for (const raw of location.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) fail("json_pointer_missing");
    value = value[key];
  }
  return value;
}

function readShopify(method, sources) {
  const spec = method.platform, source = sources[spec.source];
  if (spec.kind !== "shopify" || source?.kind !== "json") fail("platform_source");
  const product = pointer(source.value, spec.pointer);
  const expected = new URL(method.productUrl);
  if (product.handle !== expected.pathname.replace(/\/$/, "").split("/").at(-1)
    || product.id == null || !Array.isArray(product.variants) || !product.variants.length) fail("platform_identity");
  // Reuse the old website variant mapping; never infer fields from body text.
  let variants = normalizePlatformVariants(product, method.productUrl);
  if (variants.length !== product.variants.length || variants.some(v => !v.variantId)
    || new Set(variants.map(v => v.variantId)).size !== variants.length) fail("platform_variants");
  if (spec.offerSource === undefined) {
    if (variants.some(variant => typeof variant.available !== "boolean")) fail("availability_source_required");
    return { variants, flags: [] };
  }
  const offers = sources[spec.offerSource];
  if (offers?.kind !== "dom") fail("offer_source");
  const availability = nativeAvailability(offers.text, method.productUrl, variants);
  return { variants: availability.variants, flags: availability.flags };
}

/** Verify saved values against retained exact locations; semantic review remains the model's job. */
export async function verifyObservedProduct(root, record) {
  const observed = await readObservedProduct(root, record.fieldEvidence);
  const expectedUrl = record.productUrl ?? record.sourceUrl;
  if (observed.sourceUrl !== expectedUrl) fail("record_identity");
  const fields = { ...record.fields };
  delete fields.images; // Verified separately against the model-observed full gallery.
  if (!isDeepStrictEqual(fields, observed.fields) || !isDeepStrictEqual(record.variants ?? [], observed.variants)) fail("record_changed");
  return record.fieldEvidence.sources;
}
