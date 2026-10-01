import { AcquisitionReviewSchema } from "@crawl-automation/v3-contracts";
import { defineSignal, setHandler } from "@temporalio/workflow";
import { z } from "zod";
import type { LabelTask, Source, State } from "./label-model.js";

const FailureSchema = z.strictObject({
  operationId: z.string(),
  sourceId: z.string(),
  receipt: AcquisitionReviewSchema,
});
export const labelSourceFailed = defineSignal<[unknown]>("labelSourceFailed");

/** File failures are source evidence too; the furthest prior label source may carry the better Review reason. */
export function streamFailures(task: LabelTask, invalid: () => void) {
  const failed = new Map<string, z.infer<typeof FailureSchema>>();
  setHandler(labelSourceFailed, (raw) => {
    const failure = FailureSchema.safeParse(raw);
    if (
      !failure.success ||
      failure.data.operationId !== task.operationId ||
      failed.has(failure.data.sourceId) ||
      failed.size >= 100
    ) {
      invalid();
      return;
    }
    failed.set(failure.data.sourceId, failure.data);
  });
  return {
    failed,
    state(source: Source): State | undefined {
      const failure = failed.get(source.id);
      if (!failure) {
        return undefined;
      }
      if (
        source.kind !== "file-image" ||
        failure.receipt.operationId !== source.plan.acquire.operationId
      ) {
        invalid();
        return { id: source.id, status: "rejected" };
      }
      return { id: source.id, status: "review", reviewId: failure.receipt.reviewId };
    },
  };
}
