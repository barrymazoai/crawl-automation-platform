import { channelErrors, pageText } from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { amazonErrors } from "./errors.js";
import { isAsin } from "./address.js";
import { fallbackAsins } from "./asin-fallback.js";

export const AMAZON_MAX_BYTES = 6 * 1024 * 1024;
export type AmazonDocument = ReturnType<typeof parseHTML>["document"];
export type AmazonElement = ReturnType<AmazonDocument["querySelectorAll"]>[number];

export const cleanText = (value: string): string => value.replace(/\s+/g, " ").trim();
export const textOf = (element: AmazonElement | null): string =>
  element ? cleanText(pageText(element.outerHTML)) : "";

/** Static DOM parsing only; no page script is run and no external resources are loaded. */
export function amazonDocument(html: string): AmazonDocument {
  if (Buffer.byteLength(html) > AMAZON_MAX_BYTES) {
    throw channelErrors.create("CAPTURE.PAGE_LIMIT");
  }
  const document = parseHTML(html).document;
  const captcha = document.querySelector('form[action*="validateCaptcha"], #captchacharacters');
  const title = textOf(document.querySelector("title"));
  if (captcha || /Robot Check/i.test(title)) {
    throw channelErrors.create("CAPTURE.ACCESS_CHALLENGE");
  }
  return document;
}

/** Excludes static hidden offer templates, but keeps aria-hidden price digits for price readers. */
export const hidden = (element: AmazonElement): boolean =>
  Boolean(
    element.closest('[hidden], .aok-hidden, [style*="display:none"], [style*="display: none"]'),
  );

export function productRoot(document: AmazonDocument): AmazonElement {
  const roots = [...document.querySelectorAll("#ppd")];
  if (roots.length !== 1 || !roots[0]) {
    throw amazonErrors.create("AMAZON.PRODUCT_UNVERIFIED");
  }
  return roots[0];
}

/**
 * Hidden ASIN fields remain authoritative. Only their absence permits product-widget metadata;
 * recommendations, variation options and the request URL are not identity.
 */
export function pageAsin(root: AmazonElement): string {
  const values = [...root.querySelectorAll('input#ASIN, input[name="ASIN"]')].map(
    (element) => element.getAttribute("value") ?? "",
  );
  if (!values.length) {
    values.push(...fallbackAsins(root));
  }
  if (!values.length || values.some((value) => !isAsin(value))) {
    throw amazonErrors.create("AMAZON.PRODUCT_UNVERIFIED");
  }
  if (new Set(values).size !== 1) {
    throw amazonErrors.create("AMAZON.ASIN_CONFLICT");
  }
  return values[0] as string;
}
