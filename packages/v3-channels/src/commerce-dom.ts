/** Whitelisted DOM values only. Ambiguous distinct values remain unknown. */
export const commerceDomExpression=(channel:"amazon"|"swanson")=>`(()=>{
 const root=document.querySelector(${JSON.stringify(channel==="amazon"?"#ppd":"main")});
 const value=(selector,scope=root)=>{if(!scope)return null;const a=[...scope.querySelectorAll(selector)].map(e=>(e.getAttribute('content')||e.getAttribute('data-product-sku')||e.getAttribute('value')||e.innerText||'').trim()).filter(Boolean);const u=[...new Set(a)];return u.length===1?u[0].slice(0,1000):null;};
 const meta=selector=>value(selector,document);
 return {codec:'public-product-commerce/1',
 sku:value('[itemprop="sku"], [data-product-sku]')${channel==="swanson"?"||(()=>{const a=[...(root?.innerText||'').matchAll(/(?:^|\\n)SKU:\\s*([A-Z][A-Z0-9-]{2,30})(?=\\s|$)/g)];return a.length===1?a[0][1]:null;})()":""},
 price:value(${JSON.stringify(channel==="amazon"?"#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen, #corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen":".product-form-plan-option.selected .product-form-plan-option-price--current")}),
 currency:meta('meta[property="product:price:currency"]')||value('[itemprop="priceCurrency"]'),
 listPrice:value(${JSON.stringify(channel==="amazon"?"#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen":"[data-compare-at-price]")}),
 rating:value(${JSON.stringify(channel==="amazon"?"#acrPopover .a-icon-alt":"[itemprop=ratingValue]")}),
 reviewCount:value(${JSON.stringify(channel==="amazon"?"#acrCustomerReviewText":"[itemprop=reviewCount]")}),
 availability:value(${JSON.stringify(channel==="amazon"?"#availability":"[itemprop=availability]")}),
 context:${channel==="amazon"?"[document.querySelector('#nav-global-location-popover-link')?.innerText||''].filter(Boolean)":"[...root.querySelectorAll('.product-form-plan-option')].slice(0,20).map(e=>(e.classList.contains('selected')?'selected: ':'unselected: ')+e.innerText.slice(0,3900))"}
 };})()`;
