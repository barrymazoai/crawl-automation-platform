import { condition, defineSignal, setHandler } from "@temporalio/workflow";

/**
 * Only the pipeline's child boundary is simulated. These run on a separate queue; parent histories
 * retain real child-start, signal and child-completion events. Label itself has its own replay suite.
 */
async function receiveFiles(prefix: string) {
  let sealed = false;
  let files = 0;
  setHandler(defineSignal<[unknown]>(`${prefix}SourceReady`), () => {
    files++;
  });
  setHandler(defineSignal<[{ status: string }]>(`${prefix}StreamSealed`), ({ status }) => {
    sealed = status === "closed";
  });
  await condition(() => sealed);
  return { status: "collected", operationId: "label-1", files };
}

export async function LabelWorkflow() {
  return receiveFiles("label");
}

export async function ChannelStreamingLabelWorkflow() {
  return receiveFiles("channel");
}
