const stockExpression = `(() => {
  const selected = productElements('variant-picker input[role="radio"]')
    .filter(input => root.contains(input))
    .filter(input => input.checked || input.getAttribute('aria-checked') === 'true');
  if (selected.length !== 1) {
    return null;
  }
  const available = selected[0].getAttribute('data-option-available');
  return available === 'false' ? 'OutOfStock' : available === 'true' ? 'InStock' : null;
})()`;

/** Whitelisted Swanson commerce fields. Distinct conflicting values remain unknown. */
export const swansonCommerceExpression = `(() => {
  const root = productElements('main [data-cnstrc-product-detail]')[0] ||
    document.querySelector('main');
  const value = (selector, scope = root) => {
    if (!scope) {
      return null;
    }
    const values = productElements(selector).filter(element => scope.contains(element))
    .map(element => (
      element.getAttribute('content') || element.getAttribute('data-product-sku') ||
      element.getAttribute('value') || element.innerText || ''
    ).trim()).filter(Boolean);
    const unique = [...new Set(values)];
    return unique.length === 1 ? unique[0].slice(0, 1000) : null;
  };
  const textSku = () => {
    const matches = [...(root?.innerText || '').matchAll(
      /(?:^|\\n)SKU:\\s*([A-Z][A-Z0-9-]{2,30})(?=\\s|$)/g
    )];
    return matches.length === 1 ? matches[0][1] : null;
  };
  const context = () => [...root.querySelectorAll('.product-form-plan-option')]
    .filter(element => productElements('.product-form-plan-option').includes(element))
    .slice(0, 20).map(element => (
      (element.classList.contains('selected') ? 'selected: ' : 'unselected: ') +
      element.innerText.slice(0, 3900)
    ));
  return {
    codec: 'public-product-commerce/1',
    sku: value('[itemprop="sku"], [data-product-sku]') || textSku(),
    price: value('.product-form-plan-option.selected .product-form-plan-option-price--current'),
    currency: value('meta[property="product:price:currency"]', document) ||
      value('[itemprop="priceCurrency"]'),
    listPrice: value('[data-compare-at-price]'),
    rating: value('[itemprop=ratingValue]'),
    reviewCount: value('[itemprop=reviewCount]'),
    availability: value('[itemprop=availability]') || ${stockExpression},
    context: context()
  };
})()`;
