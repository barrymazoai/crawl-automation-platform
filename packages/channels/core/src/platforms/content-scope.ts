import {
  allowedContent,
  contentHeading,
  contentIdentity,
  contentPolicyScript,
  foreignProductLink,
  PRODUCT_CONTENT,
  type ContentIdentity,
} from "./content-policy.js";

export interface ProductContentScope {
  root: Element | null;
  sections: Element[];
  identity: ContentIdentity;
}

const contentPolicy = {
  allowedContent,
  contentHeading,
  contentIdentity,
  foreignProductLink,
  PRODUCT_CONTENT,
};

function ownSection(
  node: Element,
  identity: ContentIdentity,
  policy: typeof contentPolicy,
): boolean {
  const { allowedContent, contentHeading, foreignProductLink, PRODUCT_CONTENT } = policy;
  if (!allowedContent(node, identity) || foreignProductLink(node, identity)) {
    return false;
  }
  if (node.matches(PRODUCT_CONTENT.identity)) {
    return true;
  }
  return [...node.querySelectorAll(PRODUCT_CONTENT.heading)].some(
    (heading) =>
      contentHeading(heading) &&
      allowedContent(heading, identity) &&
      heading.closest(PRODUCT_CONTENT.section) === node,
  );
}

/** Additional sections must be in the same main, outside the product root, with positive ownership evidence. */
function findProductContent(
  document: Document,
  own: { url: string; productId?: string; productSelector?: string },
  policy: typeof contentPolicy,
): ProductContentScope {
  const { contentIdentity, PRODUCT_CONTENT } = policy;
  const root = document.querySelector(own.productSelector ?? PRODUCT_CONTENT.root);
  const identity = contentIdentity(root, own);
  const main = root?.closest(PRODUCT_CONTENT.main) ?? document.querySelector(PRODUCT_CONTENT.main);
  const candidates = [
    ...(main?.querySelectorAll(`${PRODUCT_CONTENT.section}, ${PRODUCT_CONTENT.identity}`) ?? []),
  ].filter(
    (node) => !root?.contains(node) && !node.contains(root) && ownSection(node, identity, policy),
  );
  const sections = candidates.filter(
    (node) => !candidates.some((parent) => parent !== node && parent.contains(node)),
  );
  return { root, sections, identity };
}

export function productContentScope(
  document: Document,
  own: Parameters<typeof findProductContent>[1],
) {
  return findProductContent(document, own, contentPolicy);
}

/** Strip excluded descendants before serializing a candidate; checking only its parent leaks nested widgets. */
export function ownContentHtml(node: Element, identity?: ContentIdentity): string {
  const copy = node.cloneNode(true) as Element;
  for (const child of copy.querySelectorAll("*")) {
    if (!allowedContent(child, identity)) {
      child.remove();
    }
  }
  return copy.outerHTML;
}

export function productContentScopeScript(): string {
  return [
    contentPolicyScript(),
    ownSection.toString(),
    findProductContent.toString(),
    "const contentPolicy = { allowedContent, contentHeading, contentIdentity, foreignProductLink, PRODUCT_CONTENT };",
    "const productContentScope = (document, own) => findProductContent(document, own, contentPolicy);",
  ].join("\n");
}
