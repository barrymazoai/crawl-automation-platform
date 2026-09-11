export { ChannelSavedLabelWorkflow } from "../../../packages/v3-product/src/channel-saved-workflow.js";
import { finishLabelProduct } from "../../../packages/v3-product/src/label-workflow.js";
import { LabelProductJoinSchema, VisionTaskSchema, imageActivityOptions } from "@crawl-automation/v3-contracts";
import { proxyActivities } from "@temporalio/workflow";
import { PreparedTextWorkflow } from "../../../packages/v3-product/src/text-workflow.js";
import { resourceGate } from "../../../packages/v3-product/src/resource-workflow.js";
import { ResourceGateSchema } from "@crawl-automation/v3-contracts";
export async function TextQualityProbe(raw:{text:unknown;resources:unknown}){
  return PreparedTextWorkflow(raw.text,resourceGate(ResourceGateSchema.parse(raw.resources)),true);
}
export async function VisionQualityProbe(raw:{task:unknown;queue:string;resources:unknown}){
  const gate=resourceGate(ResourceGateSchema.parse(raw.resources));
  return gate("interpretImage",()=>proxyActivities<{interpretImage(raw:unknown):Promise<unknown>}>(imageActivityOptions(raw.queue)).interpretImage(VisionTaskSchema.parse(raw.task)));
}
export async function CollectQualityProbe(raw:{input:unknown;queue:string}){
  return proxyActivities<{collectLabelProduct(raw:unknown):Promise<unknown>}>(imageActivityOptions(raw.queue)).collectLabelProduct(raw.input);
}
export async function AssembleLabelJoinProbe(raw:{join:unknown;queue:string}){
  return proxyActivities<{assembleLabelProduct(raw:unknown):Promise<unknown>}>({taskQueue:raw.queue,startToCloseTimeout:"2 minutes",heartbeatTimeout:"20 seconds",retry:{maximumAttempts:1}}).assembleLabelProduct(LabelProductJoinSchema.parse(raw.join));
}
export async function SavedQualityJoinWorkflow(raw:{join:unknown;queues:{assembly:string;collection:string}}){
  return finishLabelProduct(LabelProductJoinSchema.parse(raw.join),raw.queues);
}
export async function SwansonCoreProbe(raw:{input:unknown;queue:string}){
  return proxyActivities<{prepareSwansonLabelCore(raw:unknown):Promise<unknown>}>({taskQueue:raw.queue,startToCloseTimeout:"60 seconds",retry:{maximumAttempts:1}}).prepareSwansonLabelCore(raw.input);
}
