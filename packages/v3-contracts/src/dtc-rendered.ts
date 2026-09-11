import {z} from "zod";
const url=z.string().url().max(4096), index=z.number().int().min(0).max(1199);
export const DtcSitePolicySchema=z.strictObject({origin:url,brandName:z.string().min(1).max(1000),
  catalogPages:z.array(url).min(1).max(10),productPathPrefix:z.string().startsWith("/").min(2).max(500),
  catalogRoot:z.string().min(1).max(500),productRoot:z.string().min(1).max(500),
  imageOrigins:z.array(url).min(1).max(20),galleryControls:z.array(z.string().min(1).max(500)).max(20),
  galleryDismissControls:z.array(z.string().min(1).max(500)).max(10).optional(),
  maxDecisions:z.number().int().min(1).max(12),selectedUrls:z.array(url).min(1).max(100).nullable(),
});
export type DtcSitePolicy=z.infer<typeof DtcSitePolicySchema>;
export const DtcSnapshotSchema=z.strictObject({url,title:z.string().max(4000),capturedAt:z.string().datetime(),
  nodes:z.array(z.strictObject({index,tag:z.string().max(20),text:z.string().max(6000),href:url.nullable(),src:url.nullable(),width:z.number().nonnegative(),height:z.number().nonnegative(),control:z.boolean()})).max(1200),
});
export type DtcSnapshot=z.infer<typeof DtcSnapshotSchema>;
export const DtcDecisionSchema=z.strictObject({action:z.enum(["capture","click","review"]),title:index.nullable(),sections:z.array(index).max(20),links:z.array(index).max(100),images:z.array(index).max(100),control:index.nullable(),reason:z.enum(["none","challenge","identity_uncertain","not_product","insufficient_evidence"])});
export const DtcRenderedProductSchema=z.strictObject({codec:z.literal("dtc-rendered/1"),url,listingId:z.string().regex(/^dtc-[a-f0-9]{64}$/),brandName:z.string().min(1),title:z.string().min(1).max(4000),
  sections:z.array(z.string().min(1).max(6000)).max(20),images:z.array(url).min(1).max(100),
  selectedOnly:z.literal(true),snapshotKeys:z.array(z.string().min(1)).min(1).max(12),
});
export const DtcRenderedCatalogSchema=z.strictObject({codec:z.literal("dtc-catalog-rendered/1"),url,brandName:z.string().min(1),
  entries:z.array(z.strictObject({listingId:z.string().regex(/^dtc-[a-f0-9]{64}$/),variantId:z.null(),url,title:z.string().max(4000).nullable()})).max(100),
  navigation:z.array(url).max(100),snapshotKeys:z.array(z.string().min(1)).min(1).max(12),
});
