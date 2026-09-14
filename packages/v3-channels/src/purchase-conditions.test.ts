import {expect,it} from 'vitest';
import {readPurchaseDom,priceHtml,sellerHtml} from './purchase-conditions.fixture.js';
import {CommerceEvidenceSchema} from '../../v3-contracts/src/commerce.js';

it('binds the selected one-time offer, ignoring a different unselected subscription and seller',()=>{
 const {commerce,conditions:c}=readPurchaseDom(`<div id="buyBoxAccordion"><div class="a-box a-accordion-active">One-time purchase\n${priceHtml()}${sellerHtml}<select name="quantity" data-selected="2"><option>2</option></select></div><div class="a-box">Subscribe &amp; Save\n${priceHtml('6.99')}<div>Sold by\nWrong seller</div></div></div>`);
 expect(commerce.price).toBe('$7.99');expect(c).toMatchObject({purchaseType:'one_time',seller:{name:'Carlyle',id:'ABC123'},shipsFrom:'Amazon',quantity:2,priceScope:'selected_offer',delivery:{postalCode:'10001',countryCode:null}});
 expect(CommerceEvidenceSchema.parse(commerce).purchaseConditions).toEqual(c);
});
it('reads combined shipper/seller in a plain box without inventing purchase type',()=>{
 const c=readPurchaseDom(`<div id="buybox">${priceHtml()}<div>Shipper / Seller</div><div>Amazon.com</div><button>Add to cart</button></div>`).conditions;
 expect(c).toMatchObject({seller:{name:'Amazon.com',id:null,url:null},shipsFrom:'Amazon.com',purchaseType:'unknown',priceScope:'selected_offer'});
});
it('does not bind different main and selected prices or choose between multiple active offers',()=>{
 const active=`<div class="a-box a-accordion-active">One-time purchase\n${priceHtml('6.99')}${sellerHtml}</div>`;
 expect(readPurchaseDom(`<div id="buyBoxAccordion">${active}</div>`).conditions.priceScope).toBe('page_display');
 expect(readPurchaseDom(`<div id="buyBoxAccordion">${active}${active}</div>`).conditions).toMatchObject({purchaseType:'unknown',seller:{name:null},priceScope:'page_display'});
});
it('retains coupon requirements without subtracting them or treating checkbox selection as application',()=>{
 const {commerce,conditions:c}=readPurchaseDom(`<div id="buybox">${priceHtml()}${sellerHtml}<div id="couponsInBuybox_feature_div">Save 10% with coupon. Prime members only, first subscription order.<input type="checkbox" checked></div></div>`);
 expect(commerce.price).toBe('$7.99');expect(c.promotions[0]).toMatchObject({type:'coupon',percent:'10',applied:null,amount:null});
 expect(c.promotions[0]!.conditionsText).toContain('first subscription');
});
it('reads selected subscription and selected variant, while missing promotions remain unknown',()=>{
 const c=readPurchaseDom(`<div id="buyBoxAccordion"><div class="a-box a-accordion-active">Subscribe &amp; Save\n${priceHtml()}${sellerHtml}<span id="sns-frequency">Every 2 months</span></div></div>`, '<div id="variation_size_name"><label class="a-form-label">Size:</label><span class="selection">60 Count (Pack of 2)</span></div>').conditions;
 expect(c.purchaseType).toBe('subscription');expect(c.subscription?.frequencyText).toBe('Every 2 months');
 expect(c.selectedOptions).toEqual([{name:'Size:',value:'60 Count (Pack of 2)'}]);expect(c.warnings).toContain('PURCHASE.PROMOTIONS_NOT_OBSERVED');
});
it('ignores hidden coupon panels and preserves the old schema byte ordering with no new defaults',()=>{
 const c=readPurchaseDom(`<div id="buybox">${priceHtml()}</div>`,'<div id="coupons_feature_div" hidden>Save 30% coupon</div>').commerce;
 expect(c.purchaseConditions.promotions).toEqual([]);delete c.purchaseConditions;
 const old=JSON.stringify(c);expect(JSON.stringify(CommerceEvidenceSchema.parse(c))).toBe(old);expect(c).not.toHaveProperty('purchaseConditions');
});
const nativeOffer=`<form id="addToCart">${priceHtml()}<input id="add-to-cart-button" name="submit.add-to-cart" type="submit" formaction="/cart/add-to-cart/ref=test"><input id="buy-now-button" name="submit.buy-now" type="submit" formaction="/checkout/entry/buynow"></form>`;
it('recognizes the observed native plain purchase form without inferring missing quantity',()=>{
 const c=readPurchaseDom(`<div id="buybox">${nativeOffer}</div>`).conditions;
 expect(c).toMatchObject({purchaseType:'one_time',quantity:null,priceScope:'selected_offer'});
 expect(c.evidence.some(e=>e.field==='purchaseType')).toBe(true);expect(c.warnings).toContain('PURCHASE.QUANTITY_NOT_OBSERVED');
});
it.each([
 nativeOffer.replace('/checkout/entry/buynow','https://foreign.example/checkout/entry/buynow'),
 nativeOffer.replace('name="submit.buy-now"','name="submit.subscribe"'),
 nativeOffer.replace('<input id="buy-now-button"','<input hidden id="buy-now-button"'),
 'Subscribe & Save\n'+nativeOffer,
 nativeOffer+nativeOffer,
])('does not classify an ambiguous or foreign native form as one-time',offer=>{
 expect(readPurchaseDom(`<div id="buybox">${offer}</div>`).conditions.purchaseType).not.toBe('one_time');
});
function inlineOption(asin='B0GGVD471R',label='120 Count (Pack of 2)'){
 return `<input id="ASIN" value="B0GGVD471R"><div id="inline-twister-row-size_name"><div id="inline-twister-dim-title-size_name"><span class="a-color-secondary">Size:</span><span id="inline-twister-expanded-dimension-text-size_name">120 Count (Pack of 2)</span></div><li data-asin="${asin}"><input role="radio" aria-checked="true"><span class="swatch-title-text">${label}</span></li><li data-asin="B00JRAPTZK"><input role="radio" aria-checked="false"><span class="swatch-title-text">120 Count (Pack of 1)</span></li></div>`;
}
it('retains a new inline twister selection bound to the current ASIN, not its alternative price',()=>{
 const {commerce,conditions}=readPurchaseDom(`<div id="buybox">${nativeOffer}</div>`,inlineOption());
 expect(conditions.selectedOptions).toEqual([{name:'Size:',value:'120 Count (Pack of 2)'}]);expect(commerce.price).toBe('$7.99');
});
it.each([inlineOption('B00JRAPTZK'),inlineOption('B0GGVD471R','120 Count (Pack of 1)')])('rejects stale inline selection state',html=>{
 const c=readPurchaseDom(`<div id="buybox">${nativeOffer}</div>`,html).conditions;expect(c.selectedOptions).toEqual([]);expect(c.warnings).toContain('PURCHASE.OPTION_SELECTION_UNKNOWN');
});
