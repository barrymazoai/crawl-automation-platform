import {it,expect} from 'vitest';
import {runInNewContext} from 'node:vm';
import {amazonCommerceDomExpression} from './commerce-dom.js';

function offer(price:string,shown=true){
 const [whole,fraction]=price.split('.');
 return {shown,getClientRects:()=>shown?[{}]:[],querySelector:(s:string)=>({textContent:({'.a-offscreen':' ','.a-price-symbol':'$','.a-price-whole':whole+'.','.a-price-fraction':fraction} as Record<string,string>)[s]??''})};
}
function read(main:ReturnType<typeof offer>[],selected:ReturnType<typeof offer>[]=[],currency:string|null='USD'){
 const availability=(text:string,shown:boolean)=>({shown,innerText:text,getClientRects:()=>shown?[{}]:[],getAttribute:()=>null});
 const root={querySelectorAll:(s:string)=>({
  '#corePriceDisplay_desktop_feature_div .priceToPay':main,
  '#buyBoxAccordion .a-accordion-active #corePrice_feature_div .apex-pricetopay-value':selected,
  '#availability':[availability('In Stock',true),availability('Only 1 left',false)],
 } as Record<string,unknown[]>)[s]??[]};
 const document={querySelector:(s:string)=>s==='#ppd'?root:null,querySelectorAll:(s:string)=>s==='input[id="currencyOfPreference"]'&&currency?[{getAttribute:()=>currency}]:[]};
 return runInNewContext(amazonCommerceDomExpression,{document,getComputedStyle:()=>({visibility:'visible'})});
}
it('reads the split visible main price while ignoring hidden subscription tiers',()=>{
 expect(read([offer('16.99'),offer('16.10',false),offer('15.21',false)])).toMatchObject({price:'$16.99',currency:'USD',availability:'In Stock'});
});
it('conflicting visible main prices remain unknown even with a selected offer',()=>{
 expect(read([offer('16.99'),offer('16.10')],[offer('16.99')]).price).toBeNull();
});
it('uses a selected purchase offer only when the main price is absent',()=>{
 expect(read([],[offer('10.45')],null)).toMatchObject({price:'$10.45',currency:null});
});
