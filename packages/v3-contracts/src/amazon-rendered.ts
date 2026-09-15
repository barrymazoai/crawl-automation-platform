import {z} from 'zod';
import {CommerceEvidenceSchema} from './commerce.js';
const url=z.string().url().max(4096),asin=z.string().regex(/^[A-Z0-9]{10}$/);
// Public selected-product DOM only. No scripts, cookies, account or runtime globals.
export const AmazonRenderedProductSchema=z.strictObject({codec:z.literal('amazon-rendered/1'),url,canonicalUrl:url,capturedAt:z.iso.datetime(),asin,title:z.string().trim().min(1).max(4000),brandRaw:z.string().max(1000),storeUrl:url,
 commerce:CommerceEvidenceSchema.optional(),deliveryText:z.string().max(1000),galleryCount:z.number().int().min(1).max(100),gallery:z.array(z.strictObject({index:z.number().int().min(0).max(99),url,alt:z.string().max(4000)})).min(1).max(100),
 sections:z.array(z.strictObject({id:z.enum(['feature-bullets','productDescription','important-information']),text:z.string().max(500000)})).max(3),
 variantControls:z.number().int().nonnegative(),variants:z.array(z.strictObject({asin,url,label:z.string().max(1000)})).max(100),
 // Static-HTML capture only: twister parent and the fetch route. Absent on browser projections.
 parentAsin:asin.optional(),fetchedVia:z.strictObject({mode:z.literal('http'),routeId:z.string().min(1).max(200),egressId:z.string().min(1).max(200),provider:z.string().min(1).max(200)}).optional()});
export const AmazonRenderedCatalogSchema=z.strictObject({codec:z.literal('amazon-catalog-rendered/1'),url,capturedAt:z.iso.datetime(),storeName:z.string().min(1).max(1000),deliveryText:z.string().max(1000),
 cards:z.array(z.strictObject({links:z.array(url).min(1).max(10),title:z.string().max(4000),sponsored:z.boolean()})).min(1).max(100),
 navigation:z.array(z.strictObject({label:z.string().max(1000),url})).max(50)});
export type AmazonRenderedProduct=z.infer<typeof AmazonRenderedProductSchema>;
