import {amazonPurchaseConditionsDomExpression} from './purchase-conditions-dom.js';
/** Amazon displays multiple purchase offers and duplicates IDs. Read the visible
 * main price, retaining its selected-offer context; never combine subscription,
 * unit, recommended-item or hidden prices. */
export const amazonCommerceDomExpression=`(()=>{
 const root=document.querySelector('#ppd');
 const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const unique=values=>{const a=[...new Set(values.map(s=>s.trim()).filter(Boolean))];return a.length===1?a[0].slice(0,1000):null;};
 const elements=(selector,scope=root)=>scope?[...scope.querySelectorAll(selector)]:[];
 const value=(selector,scope=root,visibleOnly=false)=>unique(elements(selector,scope).filter(e=>!visibleOnly||visible(e)).map(e=>e.getAttribute('content')||e.getAttribute('value')||e.getAttribute('data-product-sku')||e.innerText||''));
 const amount=e=>{const accessible=e.querySelector('.a-offscreen')?.textContent?.trim();if(accessible)return accessible;
  const symbol=e.querySelector('.a-price-symbol')?.textContent?.trim(),whole=e.querySelector('.a-price-whole')?.textContent?.trim(),fraction=e.querySelector('.a-price-fraction')?.textContent?.trim();
  if(!symbol||!whole||!/^\\d[\\d,]*\\.?$/.test(whole)||!/^\\d{2}$/.test(fraction||''))return '';return symbol+whole+(whole.endsWith('.')?'':'.')+fraction;};
 const main=elements('#corePriceDisplay_desktop_feature_div .priceToPay').filter(visible);
 const accordion=elements('#buyBoxAccordion').filter(visible);
 const boxes=elements('#buybox').filter(visible);
 const selected=elements('#buyBoxAccordion .a-accordion-active #corePrice_feature_div .apex-pricetopay-value').filter(visible);
 // A plain buybox has no accordion. Its own price can disambiguate duplicated
 // main blocks for a different offer; do not fall back to arbitrary page dollars.
 const plain=accordion.length===0&&boxes.length===1?elements('#corePrice_feature_div .apex-pricetopay-value, #corePrice_feature_div .priceToPay',boxes[0]).filter(visible):[];
 // Static HTML can carry several main-block variants at once (one-time and subscription); only a single
 // readable main amount is trusted, otherwise the selected offer's own amount is the visible price.
 const mainAmounts=main.map(amount).filter(Boolean);
 const price=(mainAmounts.length?unique(mainAmounts):null)??unique((selected.length?selected:plain).map(amount));
 const mainRegions=elements('#corePriceDisplay_desktop_feature_div').filter(visible);
 const selectedOffers=elements('#buyBoxAccordion .a-accordion-active');
 const availability=value('#availability',root,true),buyboxText=boxes.map(e=>e.innerText||'').join(' ');
 const priceStatus=price?'observed':/Currently unavailable|Out of stock/i.test(availability||'')?'unavailable':
  /See All Buying Options/i.test(buyboxText)?'buying_options':/To see product details, add this item to your cart/i.test(buyboxText)?'cart_required':
  new Set(mainAmounts).size>1?'ambiguous':'not_observed';
 const salesSelector='#socialProofingAsinFaceout_feature_div';
 const salesText=unique(elements(salesSelector).filter(visible).map(e=>{
  const copy=e.cloneNode(true);copy.querySelectorAll('script,style,noscript,template').forEach(n=>n.remove());
  return (copy.textContent||'').replace(/\\s+/g,' ').trim();
 }));
 const sold=salesText?.match(/^(\\d+(?:,\\d{3})*(?:\\.\\d+)?)([KM])?(\\+)? bought in (?:the )?past (month|week)$/i);
 const soldNumber=sold?Number(sold[1].replaceAll(',',''))*({K:1000,M:1000000}[(sold[2]||'').toUpperCase()]||1):null;
 const salesVolume=sold&&Number.isSafeInteger(soldNumber)&&soldNumber>0?{text:salesText,lowerBound:String(soldNumber),
  approximate:!!sold[2]||!!sold[3],period:sold[4].toLowerCase()==='month'?'past_month':'past_week',selector:salesSelector}:null;
 return {codec:'public-product-commerce/1',sku:value('[itemprop="sku"], [data-product-sku]'),price,
 currency:value('meta[property="product:price:currency"]',document)||value('[itemprop="priceCurrency"]')||value('input[id="currencyOfPreference"]',document),
 listPrice:unique(mainRegions.flatMap(e=>elements('.apex-basisprice-value',e).filter(visible).map(amount))),
 rating:value('#acrPopover .a-icon-alt'),reviewCount:value('#acrCustomerReviewText'),availability,salesVolume,priceStatus,
 context:[document.querySelector('#nav-global-location-popover-link')?.innerText||'',...mainRegions.map(e=>'main offer: '+e.innerText.slice(0,1200)),...selectedOffers.map(e=>'selected offer: '+e.innerText.slice(0,2500))].filter(Boolean),
 purchaseConditions:${amazonPurchaseConditionsDomExpression}};
})()`;
/** Whitelisted DOM values only. Ambiguous distinct values remain unknown. */
const legacyCommerceDomExpression=(channel:"amazon"|"swanson")=>`(()=>{
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

export const commerceDomExpression=(channel:"amazon"|"swanson")=>channel==="amazon"?amazonCommerceDomExpression:legacyCommerceDomExpression(channel);
