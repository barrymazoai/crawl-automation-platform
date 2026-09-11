/** Temporal's Activity context can carry a protobuf WorkflowExecution instance.
 * Persist only its identity fields so JSON round trips preserve deep equality.
 */
export function dtcExecutionIdentity(execution: {workflowId: string; runId: string} | undefined) {
  if (!execution) throw Error('DTC.WORKFLOW_REQUIRED');
  return {workflowId: execution.workflowId, runId: execution.runId};
}
