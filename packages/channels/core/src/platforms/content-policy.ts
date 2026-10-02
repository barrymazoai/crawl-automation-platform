/** Shared by retained-page readers and the bounded browser preparation. */
export const PRODUCT_CONTENT = {
  root: 'product-info, [id^="MainProduct-"], .product.type-product, [itemscope][itemtype$="/Product"]',
  main: 'main, #MainContent, #main-content, .site-main, [role="main"]',
  section: 'section, article, details, .shopify-section, [role="region"]',
  heading: 'h1, h2, h3, h4, h5, h6, summary, [role="heading"], button[aria-controls]',
  identity: "[data-product-id], [data-product_id], [data-product-handle], [data-product_handle]",
  excluded:
    'nav, aside, [role="banner"], [role="contentinfo"], dialog, [role="dialog"], ' +
    "product-recommendations, cart-drawer, .related, .upsells, .cross-sells, " +
    '.product-card, .card-wrapper, [data-product-card], [itemtype$="/Review"]',
};

export interface ContentIdentity {
  url: string;
  ids: string[];
  handle: string;
  root: Element | null;
}

export function contentIdentity(root: Element | null, own: { url: string; productId?: string }) {
  const form = root?.querySelector("form[data-product_id], form[data-product-id]");
  const cart = root?.querySelector('[name="add-to-cart"]');
  const cartId = cart && allowedContent(cart) ? cart.getAttribute("value") : null;
  const ids = [own.productId, cartId, ...[root, form].flatMap(productIds)].filter(
    (value): value is string => Boolean(value),
  );
  return {
    url: own.url,
    ids: [...new Set(ids)],
    handle: new URL(own.url).pathname.replace(/\/$/, "").split("/").at(-1) ?? "",
    root,
  };
}

function productIds(node: Element | null | undefined): string[] {
  return ["data-product-id", "data-product_id"]
    .map((name) => node?.getAttribute(name))
    .filter((value): value is string => Boolean(value));
}

export function contentHeading(node: Element): boolean {
  return /^(?:(?:supplement|nutrition)\s+facts|(?:other\s+)?ingredients|(?:product\s+)?label)(?:\s|:|$)/i.test(
    (node.textContent ?? "").trim(),
  );
}

export function excludedContent(node: Element): boolean {
  const marker = [
    node.id,
    ...["class", "aria-label", "data-widget", "data-section-type"].map((name) =>
      node.getAttribute(name),
    ),
  ].join(" ");
  const excluded =
    /recommend|related[-_ ]?products|upsell|cross[-_ ]?sell|recently[-_ ]?viewed|cart[-_ ]?drawer|reviews?|testimonials?|blog|newsletter|featured[-_ ]?collection|(?:site|shopify-section|shopify-section-group)[-_ ].*(?:header|footer)/i;
  const heading = node.matches(PRODUCT_CONTENT.section)
    ? (node.querySelector(PRODUCT_CONTENT.heading)?.textContent ?? "")
    : "";
  return (
    node.matches(PRODUCT_CONTENT.excluded) ||
    excluded.test(marker) ||
    /^(?:you (?:may|might) also like|(?:related|recommended|other) products|customers also|reviews|from the blog)/i.test(
      heading.trim(),
    ) ||
    (node.matches("header, footer") &&
      !node.closest(`${PRODUCT_CONTENT.section}, ${PRODUCT_CONTENT.root}`))
  );
}

export function foreignContent(node: Element, identity: ContentIdentity): boolean {
  if (
    node.matches(PRODUCT_CONTENT.root) &&
    !identity.root?.contains(node) &&
    !node.contains(identity.root)
  ) {
    return true;
  }
  const handles = ["data-product-handle", "data-product_handle"]
    .map((name) => node.getAttribute(name))
    .filter(Boolean);
  return (
    productIds(node).some((value) => !identity.ids.includes(value)) ||
    handles.some((value) => value !== identity.handle)
  );
}

export function allowedContent(node: Element, identity?: ContentIdentity): boolean {
  for (let parent: Element | null = node; parent; parent = parent.parentElement) {
    if (excludedContent(parent) || (identity && foreignContent(parent, identity))) {
      return false;
    }
  }
  return true;
}

export function foreignProductLink(node: Element, identity: ContentIdentity): boolean {
  return [...node.querySelectorAll("a[href]")].some((link) => {
    const raw = link.getAttribute("href") ?? "";
    if (!URL.canParse(raw, identity.url)) {
      return true;
    }
    const target = new URL(raw, identity.url);
    const own = new URL(identity.url);
    return (
      /\/products?\//.test(target.pathname) &&
      (target.origin !== own.origin ||
        target.pathname.replace(/\/$/, "").split("/").at(-1) !== identity.handle)
    );
  });
}

/** Function sources are shipped with constants, never copied into a second browser implementation. */
export function contentPolicyScript(): string {
  return [
    `const PRODUCT_CONTENT = ${JSON.stringify(PRODUCT_CONTENT)};`,
    productIds.toString(),
    contentIdentity.toString(),
    contentHeading.toString(),
    excludedContent.toString(),
    foreignContent.toString(),
    allowedContent.toString(),
    foreignProductLink.toString(),
  ].join("\n");
}
