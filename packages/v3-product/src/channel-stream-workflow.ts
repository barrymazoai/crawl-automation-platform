import {condition,defineSignal,setHandler} from "@temporalio/workflow";
import {ChannelSavedLabelWorkflowInputSchema,ChannelSourceReadySchema,ChannelStreamSealSchema,assertArtifactBelongsTo} from "@crawl-automation/v3-contracts";
import {runChannelLabelWorkflow} from "./channel-saved-workflow.js";
export const channelSourceReady=defineSignal<[unknown]>("channelSourceReady");
export const channelStreamSealed=defineSignal<[unknown]>("channelStreamSealed");
/** Signals are only readiness hints. Every source is subsequently verified from durable evidence. */
export async function ChannelStreamingLabelWorkflow(raw:unknown){
  const entry=ChannelSavedLabelWorkflowInputSchema.parse(raw),id=entry.input.operationId,owner=entry.input.sourcePlan.owner;
  const files=new Map<string,ReturnType<typeof ChannelSourceReadySchema.parse>>();
  let sealed:ReturnType<typeof ChannelStreamSealSchema.parse>|undefined,invalid=false;
  setHandler(channelSourceReady,value=>{
    const r=ChannelSourceReadySchema.safeParse(value);if(!r.success||r.data.operationId!==id){invalid=true;return;}
    try{assertArtifactBelongsTo(r.data.file,owner);}catch{invalid=true;return;}
    const prior=files.get(r.data.sourceId);
    if(prior){if(JSON.stringify(prior)!==JSON.stringify(r.data))invalid=true;return;}
    if(sealed||files.size>=100){invalid=true;return;}
    files.set(r.data.sourceId,r.data);
  });
  setHandler(channelStreamSealed,value=>{
    const r=ChannelStreamSealSchema.safeParse(value);if(!r.success||r.data.operationId!==id){invalid=true;return;}
    if(sealed&&sealed.status!==r.data.status)invalid=true;else sealed=r.data;
  });
  const expected=new Set<string>();
  return runChannelLabelWorkflow(entry,{
    async ready(source){
      if(source.kind==="page")return true;
      if(source.kind!=="file-image")return false;
      expected.add(source.id);
      await condition(()=>files.has(source.id)||!!sealed||invalid);
      const r=files.get(source.id);if(!r||invalid)return false;
      const f=r.file,p=source.plan.acquire;
      if(f.kind!=="source-image"||f.artifactId!==source.plan.imageId||f.producer.operationId!==p.operationId||f.producer.module!=="file.acquire"||f.producer.implementationVersion!==p.implementationVersion){invalid=true;return false;}
      return true;
    },
    async finish(){await condition(()=>!!sealed||invalid);return !invalid&&sealed?.status==="closed"&&files.size===expected.size&&[...files.keys()].every(id=>expected.has(id));},
  });
}
