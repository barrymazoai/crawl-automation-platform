import { WorkflowNotFoundError, type Client } from "@temporalio/client";
import { expect, it } from "vitest";
import { TemporalRunExecutions } from "./temporal-run-executions.js";
import { TemporalWorkflowTree } from "./temporal-workflow-tree.js";

function clientWith(failure: Error): Client {
  return {
    workflow: {
      getHandle: () => ({
        describe: async () => {
          throw failure;
        },
      }),
    },
    connection: { withDeadline: (_deadline: number, work: () => unknown) => work() },
  } as unknown as Client;
}

it("maps only WorkflowNotFoundError (NOT_FOUND) to absent execution evidence", async () => {
  const client = clientWith(new WorkflowNotFoundError("not found", "workflow", "run"));
  await expect(new TemporalRunExecutions(client).execution("run")).resolves.toEqual({
    status: "MISSING",
    result: null,
  });
  await expect(
    new TemporalWorkflowTree(client).stopEvidence("workflow", "run"),
  ).resolves.toBeNull();
  const failure = new Error("not found");
  const broken = clientWith(failure);
  await expect(new TemporalRunExecutions(broken).execution("run")).rejects.toBe(failure);
  await expect(new TemporalWorkflowTree(broken).stopEvidence("workflow", "run")).rejects.toBe(
    failure,
  );
});
