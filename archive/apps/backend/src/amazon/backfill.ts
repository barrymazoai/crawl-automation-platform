import { canonicalVariantForm, type ProductUnifyInput, type ProductVariant } from "../product-unify.js";

export interface AmazonBackfillSource {
  productId: string;
  productName: string;
  companyName: string | null;
  titleRaw: string | null;
  attrs: Record<string, unknown> | null;
  productForms: string[];
  /** 产品库里的变体家族 ID：保证兄弟变体同批送模型，模型才判断得出哪部分是产品线名。 */
  familyId?: string | null;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Amazon 老 attrs 的固定映射来自 ingest contract：label 是剂型，pack 是
 * Unit Count / net content，进入 strict variant.size。这里不让模型覆盖渠道证据。
 */
export function amazonStructuredVariant(attrs: Record<string, unknown> | null): ProductVariant {
  const structured: ProductVariant = {};
  const label = cleanText(attrs?.label);
  const form = canonicalVariantForm(label);
  if (form) structured.form = form;
  const pack = cleanText(attrs?.pack);
  if (pack) structured.size = pack;
  return structured;
}

export function buildAmazonBackfillUnifyInput(source: AmazonBackfillSource): ProductUnifyInput {
  const attrsRaw = source.attrs ?? {};
  const formHint = source.productForms.map(canonicalVariantForm).find(Boolean) ?? null;
  return {
    clientRef: source.productId,
    channel: "amazon",
    titleRaw: cleanText(source.titleRaw) || cleanText(source.productName),
    brand: cleanText(source.companyName) || null,
    structuredVariant: amazonStructuredVariant(attrsRaw),
    attrsRaw,
    productFormHint: formHint,
    familyKey: source.familyId ?? null,
  };
}

const PRODUCT_LINE_MODIFIERS = [
  "ultra strength",
  "extra strength",
  "high potency",
  "triple strength",
  "maximum strength",
] as const;

export function missingAmazonProductLineModifiers(sourceTitle: string, baseName: string | null, edition: unknown) {
  const title = sourceTitle.toLowerCase();
  const identity = `${baseName ?? ""} ${typeof edition === "string" ? edition : ""}`.toLowerCase();
  return PRODUCT_LINE_MODIFIERS.filter((modifier) => title.includes(modifier) && !identity.includes(modifier));
}
