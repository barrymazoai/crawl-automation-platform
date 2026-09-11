export {SwansonCatalogProductWorkflow} from "../../../packages/v3-product/src/swanson-catalog-workflow.js";
import {condition,defineSignal,setHandler} from "@temporalio/workflow";
// Synthetic downstream only; actual SKU streaming is covered by channel-stream.test.
export async function SwansonVariantProductWorkflow(){
 let done=false;setHandler(defineSignal("finish"),()=>{done=true;});await condition(()=>done);return {status:"fixture-complete"};
}
