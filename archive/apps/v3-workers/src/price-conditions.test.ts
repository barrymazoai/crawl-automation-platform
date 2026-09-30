import {expect,it} from 'vitest';
import {comparePurchaseConditions} from './price-conditions.js';
import {purchaseFixture} from '../../../packages/v3-channels/src/purchase-conditions.fixture.js';
it('does not equate absent, incomplete, different-seller or different purchase-mode conditions',()=>{
 const p=purchaseFixture();expect(comparePurchaseConditions(undefined,p).status).toBe('unknown');
 expect(comparePurchaseConditions(p,p).status).toBe('unknown');
 expect(comparePurchaseConditions({...p,purchaseType:'unknown',seller:{name:null,id:null,url:null}},p).status).toBe('unknown');
 expect(comparePurchaseConditions(p,{...p,seller:{...p.seller,name:'Different'}}).status).toBe('different');
 expect(comparePurchaseConditions(p,{...p,purchaseType:'subscription'}).status).toBe('different');
 expect(comparePurchaseConditions({...p,warnings:[]},{...p,warnings:[]}).status).toBe('recorded_conditions_match');
 for(const extra of [{selectedOptions:[{name:'Size',value:'60 count'}]},{promotions:[{type:'coupon',description:'Save 5%',amount:null,percent:'5',currency:null,conditionsText:'Clip coupon',applied:null}]}])
  expect(comparePurchaseConditions({...p,warnings:[]},{...p,...extra,warnings:[]}).status).toBe('unknown');
});
