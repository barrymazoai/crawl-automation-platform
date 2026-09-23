import {expect,it} from 'vitest';
import {commerceMetrics} from './history-observations.js';

it('carries purchase-badge volume through metrics while retaining its approximate qualifier',()=>{
 const salesVolume={text:'1K+ bought in past month',lowerBound:'1000',approximate:true,period:'past_month',selector:'#socialProofingAsinFaceout_feature_div'};
 const metrics=commerceMetrics({salesVolume});
 expect(metrics).toMatchObject({unitsSold:'1000',unitsSoldPeriod:'trailing_30d',extras:{salesVolume}});
 expect(commerceMetrics({})).toMatchObject({unitsSold:null,unitsSoldPeriod:null});
 expect(commerceMetrics({salesVolume:{...salesVolume,period:'past_week'}}).unitsSoldPeriod).toBe('unknown');
});

it.each([['(486)','486'],['(27,116)','27116'],['(4,247)','4247'],['(108)','108'],['1,248 ratings','1248'],['4,001 global ratings','4001'],[120,'120'],['0','0']])('reads a complete review-count field %s', (raw,expected)=>{
 expect(commerceMetrics({reviewCount:raw}).reviewCount).toBe(expected);
});
it.each(['4.6 out of 5 stars','(1,24)','486 ratings for similar products','1.2K','-1',1.5,'9007199254740992'])('does not invent a review count from %s',raw=>{
 expect(commerceMetrics({reviewCount:raw}).reviewCount).toBeNull();
});
it.each([['In Stock',true],['In Stock.',true],['Only 10 left in stock - order soon.',true],['https://schema.org/InStock',true],['https://schema.org/OutOfStock',false],["Currently unavailable.\nWe don't know when or if this item will be back in stock.",false],['Out of stock',false],['Usually ships within 1 to 2 months',null],['Failed to read stock',null],['Only 0 left in stock',null],[null,null]])('records current stock without inferring permanent delisting: %s',(raw,expected)=>{
 const m=commerceMetrics({availability:raw});expect(m.inStock).toBe(expected);expect(m.extras?.commerce).toEqual({availability:raw});
});
