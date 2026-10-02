import { swansonCommerceExpression } from "./swanson-commerce-expression.js";

// Variant routes omit rel=canonical but expose og:url with og:type=product.
// Neither the location nor a manufactured URL proves the page's own identity.
const canonicalExpression = `(
  document.querySelector('link[rel="canonical"]')?.href ||
  (document.querySelector('meta[property="og:type"]')?.content === 'product'
    ? document.querySelector('meta[property="og:url"]')?.content : undefined)
)`;

const formsExpression = `(() => {
  const forms = productElements(
    'product-form-component[data-product-id]'
  ).map(form => ({
    productId: form.getAttribute('data-product-id'),
    variantIds: [...form.querySelectorAll('input[name="id"]')].map(input => input.value)
  }));
  return forms.length ? forms : shopifySelection(${canonicalExpression});
})()`;

/** Page-owned identity alone, read before title, commerce, gallery or facts validation. */
export const swansonIdentityExpression = `({
  canonicalUrl: ${canonicalExpression},
  selectedForms: ${formsExpression}
})`;

const galleryExpression = `[...document.querySelectorAll(
  'slideshow-slide .product-media img'
)].map(image => ({ url: image.currentSrc || image.src, alt: image.alt || '' }))`;

const pickerExpression = `({
  unmapped: productElements('input[role="radio"]').filter(input =>
    !input.hasAttribute('data-connected-product-url') || !input.hasAttribute('data-variant-id')
  ).length,
  options: productElements(
    'input[role="radio"][data-connected-product-url][data-variant-id]'
  ).map(input => ({
    group: input.name,
    label: input.value,
    url: new URL(input.getAttribute('data-connected-product-url'), location.href).href,
    variantId: input.getAttribute('data-variant-id'),
    selected: input.checked || input.getAttribute('aria-checked') === 'true',
    available: input.getAttribute('data-option-available') === 'true'
  }))
})`;

const sectionsExpression = `[...document.querySelectorAll('details')].filter(details =>
  ['Product Details', 'Product Facts'].includes(details.querySelector('summary')?.innerText.trim())
).map(details => ({
  heading: details.querySelector('summary').innerText.trim(),
  text: details.innerText
}))`;

/** Public DOM projection, evaluated only against the retained page's static document. */
export const swansonProductExpression = `(() => {
  const headings = [...document.querySelectorAll('h1')];
  if (headings.length !== 1) {
    throw productTemplateError;
  }
  const identity = ${swansonIdentityExpression};
  return {
    url: location.href,
    capturedAt: new Date().toISOString(),
    ...identity,
    title: headings[0].innerText.trim(),
    commerce: productCommerce(identity, ${swansonCommerceExpression}),
    gallery: ${galleryExpression},
    variantPicker: ${pickerExpression},
    sections: ${sectionsExpression}
  };
})()`;
