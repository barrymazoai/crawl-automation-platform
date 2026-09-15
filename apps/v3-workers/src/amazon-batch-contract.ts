import {z} from 'zod';
export const AmazonBatchInputSchema=z.strictObject({
 campaignId:z.string().regex(/^[a-z][a-z0-9-]{0,100}$/),
 manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),
 controlQueue:z.string().min(1).max(255),cursor:z.number().int().min(0).max(2000).default(0),
 stopAfter:z.number().int().min(0).max(2000).optional(),
 // Chunks submitted concurrently (each chunk is one Brand request of <=10 products). 1 keeps the historical serial behaviour.
 maxInFlight:z.number().int().min(1).max(10).default(1),
 // Cursor indexes already submitted but not yet settled; carried across ContinueAsNew.
 inFlight:z.array(z.number().int().min(0).max(2000)).max(10).optional(),
 // Next chunk to submit (>= cursor); absent means no chunk is in flight.
 nextChunk:z.number().int().min(0).max(2000).optional(),
});
export type AmazonBatchInput=z.infer<typeof AmazonBatchInputSchema>;
export type BatchCall={campaignId:string;manifestSha256:string;requestId?:string};
export type BatchPlan={requestIds:string[];totalProducts:number};
export type BatchReport={at:string;requested:number;submittedProducts:number;submittedAttempts:number;captures:number;capturedProducts:number;savedProducts:number;moduleReviewRecords:number;pricePoints:number;comparablePricePoints:number;priceChangeExamples:unknown[]};
export type BatchChunk={settled:boolean;workflowId:string|null;state:string};
export interface AmazonBatchActivities{
 loadAmazonHistoryBatch(input:BatchCall):Promise<BatchPlan>;
 submitAmazonHistoryChunk(input:BatchCall):Promise<{accepted:boolean;workflowId:string|null}>;
 inspectAmazonHistoryChunk(input:BatchCall):Promise<BatchChunk>;
 recoverAmazonHistoryChunk(input:BatchCall):Promise<{status:string}>;
 reportAmazonHistoryBatch(input:BatchCall):Promise<BatchReport>;
}
