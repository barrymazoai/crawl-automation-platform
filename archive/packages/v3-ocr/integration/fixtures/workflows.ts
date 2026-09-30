import { condition, defineSignal, setHandler, proxyActivities } from "@temporalio/workflow";
import { ocrActivityOptions, type OcrInput, type OcrActivityOutcome } from "@crawl-automation/v3-contracts";
export async function OcrIsolationProbe(input: { task: OcrInput; queue: string; wait: boolean; twice?: boolean }) {
  if (!input.queue.startsWith("v3.test.")) throw Error("fixture queue only");
  let released = false;
  setHandler(defineSignal("release"), () => { released = true; });
  const activity = proxyActivities<{ ocrFile(input: OcrInput): Promise<OcrActivityOutcome> }>(ocrActivityOptions(input.queue));
  const first = await activity.ocrFile(input.task);
  if (input.twice) await activity.ocrFile(input.task);
  if (input.wait) await condition(() => released);
  return first;
}
