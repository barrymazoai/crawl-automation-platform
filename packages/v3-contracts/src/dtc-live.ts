import{z}from'zod';import{CatalogDiscoverySchema}from'./catalog.js';import{ExecutionIdSchema,VersionTagSchema}from'./artifacts.js';import{ResourceGateSchema}from'./resources.js';import{ChannelPlanInputSchema}from'./channel-plan.js';import{ChannelSavedLabelWorkflowInputSchema}from'./channel-label.js';
export const DtcProductJobSchema=z.strictObject({codec:z.literal('dtc-product-job/1'),discovery:CatalogDiscoverySchema,sessionId:ExecutionIdSchema,operationId:ExecutionIdSchema,queues:z.strictObject({capture:VersionTagSchema,plan:VersionTagSchema,file:VersionTagSchema,label:VersionTagSchema,review:VersionTagSchema}),resources:ResourceGateSchema}).superRefine((j,c)=>{if(j.discovery.scope.channel!=='dtc'||j.discovery.entry.kind!=='product'||j.discovery.entry.variantId!==null||!j.resources.activities.browserSession?.length||!j.resources.activities.captureDtcProduct?.length)c.addIssue({code:'custom',message:'Selected product and exclusive browser phase required'});});
export type DtcProductJob=z.infer<typeof DtcProductJobSchema>;
export const DtcProductCaptureSchema=z.strictObject({job:DtcProductJobSchema,sourcePlan:ChannelPlanInputSchema.refine(i=>i.channel==='dtc')});
export const DtcProductHandoffSchema=z.strictObject({job:DtcProductJobSchema,input:ChannelSavedLabelWorkflowInputSchema});

export const DtcScopeSkipSchema=z.strictObject({status:z.literal('skipped'),operationId:ExecutionIdSchema,url:z.url(),reason:z.literal('bundle_or_pack'),policy:z.literal('nutrition-single-product/1'),evidenceKey:z.string().min(1),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/)});

// Host receipt, never a model-generated claim. Mini verifies retained bytes before
// either resource gate is allowed to treat this as a completed browser phase.
export const DtcStoppedCaptureReviewSchema=z.strictObject({status:z.literal('capture_review'),operationId:ExecutionIdSchema,url:z.url(),
  evidenceKey:z.string().min(1),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const DtcCaptureStopProofSchema=z.strictObject({version:z.literal('dtc-capture-stop/1'),operationId:ExecutionIdSchema,url:z.url(),
  execution:z.strictObject({workflowId:ExecutionIdSchema,runId:z.uuid()}),runnerExitCode:z.literal(0),
  closure:z.strictObject({taskId:ExecutionIdSchema,targetId:z.string().min(1),status:z.literal('closed')}),
  result:z.strictObject({status:z.enum(['needs_review','failed']),summary:z.string(),reasonCode:z.string().nullable()}),
  resultSha256:z.string().regex(/^[a-f0-9]{64}$/),files:z.array(z.strictObject({path:z.string(),objectKey:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),byteSize:z.number().int().positive(),mediaType:z.string()})).max(1000),
});
