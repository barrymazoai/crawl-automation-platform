/** Embedded in the existing public commerce read. No clicks, provider calls,
 * hidden offer state, cart operations or calculated effective prices. */
export const amazonPurchaseConditionsDomExpression=String.raw`(()=>{
 const out={codec:'purchase-conditions/1',purchaseType:'unknown',seller:{name:null,id:null,url:null},shipsFrom:null,
  delivery:{countryCode:null,postalCode:null,text:null},selectedOptions:[],quantity:null,subscription:null,
  promotions:[],priceScope:price?'page_display':'unknown',evidence:[],warnings:[]};
 const warn=s=>{if(!out.warnings.includes(s)&&out.warnings.length<30)out.warnings.push(s);};
 const txt=e=>(e?.innerText||'').trim();
 const shown=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const list=(selector,scope=root)=>scope?[...scope.querySelectorAll(selector)].filter(shown):[];
 const one=values=>{const a=[...new Set(values.map(s=>(s||'').trim()).filter(Boolean))];
  if(a.some(s=>s.length>4000)){warn('PURCHASE.FIELD_TOO_LONG');return null;}return a.length===1?a[0]:null;};
 const evidence=(field,selector,value)=>{if(!value)return;if(value.length>4000)warn('PURCHASE.EVIDENCE_TRUNCATED');
  if(out.evidence.length<60)out.evidence.push({field,selector,text:value.slice(0,4000)});};
 const fieldAfter=(content,labels)=>{const lines=content.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),values=[];
  for(let i=0;i<lines.length-1;i++)if(labels.includes(lines[i]))values.push(lines[i+1]);return one(values);};
 try{
  const delivery=txt(document.querySelector('#nav-global-location-popover-link'));
  out.delivery.text=delivery?delivery.slice(0,4000):null;
  // Country is not inferred from the marketplace, IP or a five-digit number.
  const zip=delivery.match(/\b\d{5}(?:-\d{4})?\b/g)||[];out.delivery.postalCode=one(zip);
  evidence('delivery','#nav-global-location-popover-link',delivery);
  const active=list('#buyBoxAccordion .a-accordion-active'),boxes=list('#buybox');
  const accordion=list('#buyBoxAccordion');
  const selectedBox=active.length===1?active[0]:active.length===0&&accordion.length===0&&boxes.length===1?boxes[0]:null;
  const selector=active.length===1?'#buyBoxAccordion .a-accordion-active':'#buybox';
  if(!selectedBox)warn('PURCHASE.OFFER_SELECTION_UNKNOWN');
  if(selectedBox){
   const content=txt(selectedBox);evidence('selectedOffer',selector,content);
   // A plain Add to cart button alone does not prove a one-time purchase.
   const head=content.split(/\r?\n/).map(s=>s.trim()).find(Boolean)||'';
   if(/^One[-\s]time purchase\s*:?$/i.test(head))out.purchaseType='one_time';
   else if(/^Subscribe\s*&\s*Save\b/i.test(head))out.purchaseType='subscription';
   const quoted=one(list('#corePrice_feature_div .apex-pricetopay-value, #corePrice_feature_div .priceToPay',selectedBox).map(amount));
   if(price&&quoted===price)out.priceScope='selected_offer';
   else warn('PURCHASE.PRICE_BINDING_UNKNOWN');
   // The observed plain offer has both native, same-form purchase actions.
   // Read only public form/button attributes, never hidden offer/session fields.
   if(out.purchaseType==='unknown'&&accordion.length===0&&out.priceScope==='selected_offer'&&!/subscribe|subscription/i.test(content)){
    const forms=list('form#addToCart',selectedBox);
    if(forms.length===1){
     const f=forms[0],cart=list('input#add-to-cart-button[name="submit.add-to-cart"]',f),buy=list('input#buy-now-button[name="submit.buy-now"]',f);
     const action=(e,path)=>{try{const u=new URL(e.getAttribute('formaction')||'',location.href);return u.origin===location.origin&&(u.pathname===path||u.pathname.startsWith(path+'/'));}catch{return false;}};
     if(cart.length===1&&buy.length===1&&!cart[0].disabled&&!buy[0].disabled&&action(cart[0],'/cart/add-to-cart')&&action(buy[0],'/checkout/entry/buynow')){
      out.purchaseType='one_time';evidence('purchaseType',selector+' form#addToCart','Native Add to cart (/cart/add-to-cart) and Buy Now (/checkout/entry/buynow) in the selected offer');
     }
    }
   }
   const combined=fieldAfter(content,['Shipper / Seller','Ships from and sold by']);
   const anchors=list('#sellerProfileTriggerId',selectedBox),names=anchors.map(txt);
   const labelled=fieldAfter(content,['Sold by']);
   // Prefer the explicitly labelled seller link; flattened box text may join
   // neighbouring controls onto a name. Conflicting visible links stay unknown.
   out.seller.name=names.length?one(names):one([labelled,combined]);
   out.shipsFrom=one([fieldAfter(content,['Ships from']),combined]);
   const urls=anchors.filter(e=>txt(e)===out.seller.name).flatMap(e=>{
    try{const u=new URL(e.href);if(u.protocol!=='https:'||u.origin!==location.origin||u.username||u.password)return [];
     const id=u.searchParams.get('seller')||u.searchParams.get('me');return id&&/^[A-Z0-9]+$/.test(id)?[{id,url:u.origin+u.pathname+'?seller='+encodeURIComponent(id)}]:[];
    }catch{return [];}});
   out.seller.id=one(urls.map(u=>u.id));out.seller.url=out.seller.id?one(urls.filter(u=>u.id===out.seller.id).map(u=>u.url)):null;
   evidence('seller',selector+' #sellerProfileTriggerId',anchors.map(e=>txt(e)+(e.href?' '+e.href:'')).join('\n'));
   const quantities=list('select[name="quantity"], select#quantity',selectedBox);
   const q=one(quantities.map(e=>e.value));out.quantity=q&&/^\d+$/.test(q)&&Number(q)>0&&Number(q)<=10000?Number(q):null;
   evidence('quantity',selector+' select[name="quantity"]',quantities.map(e=>e.options?.[e.selectedIndex]?.text||e.value||'').join('\n'));
   if(out.quantity===null)warn('PURCHASE.QUANTITY_NOT_OBSERVED');
   if(out.purchaseType==='subscription'){
    const frequency=one(list('select[name*="frequency"], select[id*="frequency"], #sns-frequency',selectedBox).map(e=>e.options?.[e.selectedIndex]?.text||txt(e)));
    out.subscription={frequencyText:frequency?.slice(0,4000)||null,conditionsText:content.slice(0,4000)||null};
   }
  }
  for(const e of list('[id^="variation_"]')){
   const name=one(list('.a-form-label',e).map(txt)),value=one(list('.selection',e).map(txt));
   if(name&&value&&!out.selectedOptions.some(o=>o.name===name&&o.value===value)&&out.selectedOptions.length<20){
    out.selectedOptions.push({name:name.slice(0,4000),value:value.slice(0,4000)});evidence('selectedOptions','#'+e.id,name+' '+value);
   }
  }
  for(const e of list('[id^="inline-twister-row-"]')){
   const title=list('[id^="inline-twister-dim-title-"]',e),value=one(list('[id^="inline-twister-expanded-dimension-text-"]',e).map(txt));
   const name=title.length===1?one(list('.a-color-secondary',title[0]).map(txt)):null;
   const selected=list('[role="radio"][aria-checked="true"]',e),swatch=selected.length===1?selected[0].closest('li[data-asin]'):null;
   const label=swatch?one(list('.swatch-title-text',swatch).map(txt)):null;
   if(name&&value&&label===value&&swatch?.getAttribute('data-asin')===document.querySelector('#ASIN')?.value){
    if(!out.selectedOptions.some(o=>o.name===name&&o.value===value)&&out.selectedOptions.length<20){out.selectedOptions.push({name,value});evidence('selectedOptions','#'+e.id,name+' '+value);}
   }else warn('PURCHASE.OPTION_SELECTION_UNKNOWN');
  }
  const promoSelectors=['#couponsInBuybox_feature_div','#coupons_feature_div','#promoPriceBlockMessage_feature_div','#promotionMessageInsideBuyBox_feature_div','#corePriceDisplay_desktop_feature_div'];
  for(const ps of promoSelectors)for(const e of list(ps)){
   const row=e.closest('#buyBoxAccordion .a-box');if(row&&row!==selectedBox)continue;
   const content=txt(e);if(!content||!(/coupon|save|saving|discount|%|buy\s+\d|get\s+\d/i.test(content)))continue;
   if(out.promotions.some(p=>p.description===content.slice(0,4000))||out.promotions.length>=30)continue;
   const type=/coupon/i.test(content)||/coupon/i.test(ps)?'coupon':/\bbuy\s+\d|\b(?:spend|orders? over|minimum)\b/i.test(content)?'multibuy':/prime|member/i.test(content)?'membership':/saving|discount|save|%/i.test(content)?'discount':'other';
   const percentages=[...content.matchAll(/(?:save\s+|-)(\d+(?:\.\d+)?)\s*%/gi)].map(m=>m[1]);
   const amounts=[...content.matchAll(/(?:save\s+|coupon\s*:?\s*)(?:US\$|\$)\s*(\d+(?:\.\d+)?)/gi)].map(m=>m[1]);
   // Checkbox selection is not proof of an applied discount. Preserve its state as evidence only.
   evidence('promotions',ps,content);
   for(const box of list('input[type="checkbox"]',e))evidence('couponSelection',ps+' input[type="checkbox"]','checked='+String(box.checked));
   out.promotions.push({type,description:content.slice(0,4000),amount:one(amounts),percent:one(percentages),currency:null,
    conditionsText:content.slice(0,4000),applied:/\bcoupon applied\b|\bdiscount applied\b/i.test(content)?true:null});
  }
  if(!out.promotions.length)warn('PURCHASE.PROMOTIONS_NOT_OBSERVED');
  if(out.purchaseType==='unknown')warn('PURCHASE.TYPE_UNKNOWN');
  if(!out.seller.name)warn('PURCHASE.SELLER_UNKNOWN');
 }catch{warn('PURCHASE.EXTRACTION_INCOMPLETE');}
 return out;
})()`;
