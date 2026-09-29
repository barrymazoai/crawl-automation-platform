import type { Logger } from "@crawl-automation/platform";
import { Context } from "@temporalio/activity";
import { z } from "zod";

/** Where an activity's input names its run and product: at the top, or in the pipeline input it carries. */
const RunFieldsSchema = z.object({
  runId: z.string().optional(),
  operationId: z.string().optional(),
  pipeline: z.object({ runId: z.string(), operationId: z.string() }).optional(),
});

/** The run and product an activity's input names, or null where it names none. */
function namesOf(raw: unknown): { runId: string | null; operationId: string | null } {
  const fields = RunFieldsSchema.safeParse(raw);
  if (!fields.success) {
    return { runId: null, operationId: null };
  }
  const { pipeline, runId, operationId } = fields.data;
  return {
    runId: pipeline?.runId ?? runId ?? null,
    operationId: pipeline?.operationId ?? operationId ?? null,
  };
}

/**
 * A logger for one activity call: every line carries the run ID, the product's operation ID, the workflow and
 * Temporal run IDs and the activity name, so one run's lines are found with one filter.
 */
export function activityLogger(log: Logger, activity: string, raw: unknown): Logger {
  const execution = Context.current().info.workflowExecution;
  return log.child({
    activity,
    ...namesOf(raw),
    workflowId: execution?.workflowId ?? null,
    temporalRunId: execution?.runId ?? null,
  });
}
