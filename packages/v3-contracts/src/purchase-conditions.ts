import {z} from "zod";

const text=z.string().min(1).max(4000), nullableText=text.nullable();
const decimal=z.string().regex(/^\d+(?:\.\d+)?$/).nullable();
/** Public offer observations, never checkout totals or inferred buyer eligibility.
 * No defaults: parsing old captures must preserve their exact body and hash. */
export const PurchaseConditionsSchema=z.strictObject({
  codec:z.literal("purchase-conditions/1"),
  purchaseType:z.enum(["one_time","subscription","unknown"]),
  seller:z.strictObject({name:nullableText,id:nullableText,url:z.url().nullable()}),
  shipsFrom:nullableText,
  delivery:z.strictObject({countryCode:z.string().regex(/^[A-Z]{2}$/).nullable(),postalCode:nullableText,text:nullableText}),
  selectedOptions:z.array(z.strictObject({name:text,value:text})).max(20),
  quantity:z.number().int().positive().max(10000).nullable(),
  subscription:z.strictObject({frequencyText:nullableText,conditionsText:nullableText}).nullable(),
  promotions:z.array(z.strictObject({
    type:z.enum(["coupon","discount","membership","multibuy","other"]),
    description:text,amount:decimal,percent:decimal,currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
    conditionsText:text,applied:z.boolean().nullable(),
  })).max(30),
  priceScope:z.enum(["selected_offer","page_display","unknown"]),
  evidence:z.array(z.strictObject({field:text,selector:text,text})).max(60),
  warnings:z.array(text).max(30),
});
export type PurchaseConditions=z.infer<typeof PurchaseConditionsSchema>;
