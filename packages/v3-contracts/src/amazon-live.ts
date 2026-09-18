import{z}from'zod';import{CatalogDiscoverySchema}from'./catalog.js';import{ExecutionIdSchema,VersionTagSchema}from'./artifacts.js';import{ResourceGateSchema}from'./resources.js';import{ChannelPlanInputSchema}from'./channel-plan.js';import{ChannelSavedLabelWorkflowInputSchema}from'./channel-label.js';
import {AcquiredFileRecordSchema} from './acquisition.js';
export const AmazonProductJobSchema=z.strictObject({codec:z.literal('amazon-product-job/1'),discovery:CatalogDiscoverySchema,sessionId:ExecutionIdSchema,operationId:ExecutionIdSchema,queues:z.strictObject({capture:VersionTagSchema,plan:VersionTagSchema,file:VersionTagSchema,label:VersionTagSchema,review:VersionTagSchema,enrich:VersionTagSchema.optional()}),resources:ResourceGateSchema,
 // 'observation' stops the product after the page observation is recorded: price, stock and rating are stored and the
 // listing's absence or replacement is reviewed, without OCR or any model call. Formula extraction runs later.
 stopAfter:z.enum(['full','observation']).optional()}).superRefine((j,c)=>{if(j.discovery.scope.channel!=='amazon'||j.discovery.entry.kind!=='product'||j.discovery.entry.variantId!==null||!j.resources.activities.browserSession)c.addIssue({code:'custom',message:'Selected ASIN and exclusive browser phase required'});});
export type AmazonProductJob=z.infer<typeof AmazonProductJobSchema>;
export const AmazonProductCaptureSchema=z.strictObject({job:AmazonProductJobSchema,sourcePlan:ChannelPlanInputSchema.refine(i=>i.channel==='amazon')});
export const AmazonProductHandoffSchema=z.strictObject({job:AmazonProductJobSchema,input:ChannelSavedLabelWorkflowInputSchema});
// The manifest is shared; its original bytes are still local. It is not a durable
// file receipt and cannot admit OCR/model work until normal publication completes.
export const AmazonStagedFilesSchema=z.strictObject({codec:z.literal('amazon-staged-files/1'),status:z.literal('staged'),
 capture:AmazonProductCaptureSchema,storageId:z.string().regex(/^[a-f0-9]{64}$/),
 files:z.array(z.strictObject({sourceId:ExecutionIdSchema,record:AcquiredFileRecordSchema})).min(1).max(100)
}).superRefine((v,c)=>{
 const ids=new Set<string>(),ops=new Set<string>();
 for(const f of v.files){const i=f.record.input,o=v.capture.sourcePlan.owner;
  if(ids.has(f.sourceId)||ops.has(i.operationId)||i.requestId!==o.requestId||i.observationId!==o.observationId||i.brandId!==o.brandId||i.sourceId!==o.sourceId||i.listingId!==o.listingId||i.variantId!==o.variantId||i.binding.sessionId!==v.capture.job.sessionId||i.binding.egressId!==v.capture.sourcePlan.binding.egressId||f.record.file.kind!=='source-image')
   c.addIssue({code:'custom',message:'Staged file owner or identity conflict'});
  ids.add(f.sourceId);ops.add(i.operationId);
 }
});
export type AmazonStagedFiles=z.infer<typeof AmazonStagedFilesSchema>;
