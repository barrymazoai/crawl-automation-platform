import {isDeepStrictEqual} from 'node:util';
import {PurchaseConditionsSchema} from '@crawl-automation/v3-contracts';

/** Comparing only the recorded conditions is not proof of checkout/tax parity. */
export function comparePurchaseConditions(previous:unknown,current:unknown){
 const a=PurchaseConditionsSchema.safeParse(previous),b=PurchaseConditionsSchema.safeParse(current);
 if(!a.success||!b.success)return {status:'unknown',reason:'purchase_conditions_not_recorded'};
 const left=a.data,right=b.data,differences:string[]=[];
 const compare=(key:string,x:unknown,y:unknown)=>{if(x!==null&&y!==null&&x!==undefined&&y!==undefined&&!isDeepStrictEqual(x,y))differences.push(key);};
 compare('purchaseType',left.purchaseType==='unknown'?null:left.purchaseType,right.purchaseType==='unknown'?null:right.purchaseType);
 compare('seller.name',left.seller.name,right.seller.name);compare('seller.id',left.seller.id,right.seller.id);
 compare('shipsFrom',left.shipsFrom,right.shipsFrom);compare('quantity',left.quantity,right.quantity);
 compare('delivery.postalCode',left.delivery.postalCode,right.delivery.postalCode);compare('delivery.countryCode',left.delivery.countryCode,right.delivery.countryCode);
 if(left.selectedOptions.length&&right.selectedOptions.length)compare('selectedOptions',[...left.selectedOptions].sort((a,b)=>a.name.localeCompare(b.name)),[...right.selectedOptions].sort((a,b)=>a.name.localeCompare(b.name)));
 compare('subscription.frequencyText',left.subscription?.frequencyText,right.subscription?.frequencyText);
 if(left.promotions.length&&right.promotions.length)compare('promotions',left.promotions,right.promotions);
 if(differences.length)return {status:'different',reason:'recorded_conditions_differ',fields:differences};
 const oneMissing=(x:unknown,y:unknown)=>(x===null||x===undefined)!==(y===null||y===undefined);
 if(oneMissing(left.seller.id,right.seller.id)||oneMissing(left.shipsFrom,right.shipsFrom)||oneMissing(left.delivery.countryCode,right.delivery.countryCode)
  ||Boolean(left.selectedOptions.length)!==Boolean(right.selectedOptions.length)||Boolean(left.promotions.length)!==Boolean(right.promotions.length)
  ||oneMissing(left.subscription?.frequencyText,right.subscription?.frequencyText))
  return {status:'unknown',reason:'purchase_conditions_incomplete'};
 if([left,right].some(v=>v.purchaseType==='unknown'||v.priceScope!=='selected_offer'||!v.seller.name||!v.delivery.postalCode||v.quantity===null||v.warnings.length))
  return {status:'unknown',reason:'purchase_conditions_incomplete'};
 return {status:'recorded_conditions_match',reason:'recorded_fields_only_not_checkout_total'};
}
