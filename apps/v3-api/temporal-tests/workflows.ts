import { ApplicationFailure, condition, continueAsNew, defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type { CollectionWorkflowInput } from "@crawl-automation/v3-contracts";

export interface LocalProof { requestId: string; hostname: string; platform: string; pid: number }
const { echoLocal } = proxyActivities<{
  echoLocal(input: CollectionWorkflowInput): Promise<LocalProof>;
}>({ startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 1 } });

// No crawler/OCR/product DB writes. Only executed by explicit integration tests.
export async function DeliveryAcceptanceProbe(input: CollectionWorkflowInput): Promise<LocalProof> {
  let ready = false;
  let action = "";
  setHandler(defineQuery<boolean>("deliveryProbeReady"), () => ready);
  setHandler(defineSignal<[string]>("deliveryProbeAction"), value => { action = value; });
  const result = await echoLocal(input);
  ready = true;
  await condition(() => action !== "");
  if (action === "continue") return continueAsNew<typeof DeliveryAcceptanceProbe>(input);
  if (action === "fail-once") throw ApplicationFailure.retryable("Synthetic workflow retry ancestry test", "TEST.RETRY");
  return result;
}
