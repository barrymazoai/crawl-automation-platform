import {parseHTML} from 'linkedom';
import {runInNewContext} from 'node:vm';
import {amazonCommerceDomExpression} from './commerce-dom.js';
import {PurchaseConditionsSchema} from '@crawl-automation/v3-contracts';

export const priceHtml=(price='7.99')=>`<div id="corePrice_feature_div"><span class="apex-pricetopay-value"><span class="a-offscreen">$${price}</span></span></div>`;
export const sellerHtml='<div>Ships from</div><div>Amazon</div><div>Sold by</div><div><a id="sellerProfileTriggerId" href="https://www.amazon.com/gp/help/seller/at-a-glance.html?seller=ABC123">Carlyle</a></div>';
export function readPurchaseDom(box:string,extra='',main='7.99'){
 const {document,HTMLElement}=parseHTML(`<html><body><div id="nav-global-location-popover-link">Deliver to\nNew York 10001</div><div id="ppd"><div id="corePriceDisplay_desktop_feature_div"><span class="priceToPay"><span class="a-offscreen">$${main}</span></span></div>${box}${extra}</div></body></html>`);
 Object.defineProperty(HTMLElement.prototype,'getClientRects',{configurable:true,value:function(this:HTMLElement){return this.closest('[hidden]')?[]:[{}];}});
 for(const e of document.querySelectorAll('select[name="quantity"]'))Object.defineProperty(e,'value',{value:e.getAttribute('data-selected')||'1'});
 const raw=runInNewContext(amazonCommerceDomExpression,{document,location:{origin:'https://www.amazon.com'},URL,getComputedStyle:()=>({visibility:'visible'})});
 return {commerce:raw,conditions:PurchaseConditionsSchema.parse(raw.purchaseConditions)};
}
export function purchaseFixture(){return readPurchaseDom(`<div id="buyBoxAccordion"><div class="a-box a-accordion-active">One-time purchase\n${priceHtml()}${sellerHtml}<select name="quantity" data-selected="1"><option selected>1</option></select></div></div>`).conditions;}
