import { expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { amazonCommerceDomExpression } from './commerce-dom.js';
function read(markup: string) {
  const { document, HTMLElement } = parseHTML(`<html><body><div id="ppd">${markup}</div></body></html>`);
  Object.defineProperty(HTMLElement.prototype,'getClientRects',{configurable:true,value:function(this:Element){return this.closest('[hidden]')?[]:[{}];}});
  return runInNewContext(amazonCommerceDomExpression,{document,getComputedStyle:()=>({visibility:'visible'}),location:{href:'https://www.amazon.com/dp/B0013LAQS6',origin:'https://www.amazon.com'}});
}
it.each([['1K+', '1000', true],['1.5K+','1500',true],['50+','50',true],['100','100',false]])('retains the purchase badge and its lower-bound qualifier: %s',(number,lowerBound,approximate)=>{
  expect(read(`<div id="socialProofingAsinFaceout_feature_div"><span>${number} bought</span><span> in past month</span><script>ignored()</script></div>`).salesVolume)
    .toMatchObject({text:`${number} bought in past month`,lowerBound,approximate,period:'past_month'});
});
it.each([
  '<div id="socialProofingAsinFaceout_feature_div">400+ viewed in past month</div>',
  '<div id="socialProofingAsinFaceout_feature_div" hidden>1K+ bought in past month</div>',
  '<div id="pqv-bought-in-last-month">50+ bought in past month</div>',
  '<div id="recommendations">1K+ bought in past month</div>',
  '<div id="socialProofingAsinFaceout_feature_div">50+ bought in past month</div><div id="socialProofingAsinFaceout_feature_div">100+ bought in past month</div>',
])('does not turn hidden, viewed, recommended, or conflicting counts into sales',markup=>{
  expect(read(markup).salesVolume).toBeNull();
});
it('keeps a weekly window distinct from a monthly window',()=>{
  expect(read('<div id="socialProofingAsinFaceout_feature_div">200+ bought in past week</div>').salesVolume).toMatchObject({period:'past_week',lowerBound:'200'});
});
