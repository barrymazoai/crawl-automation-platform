import { Client, Connection, WorkflowIdReusePolicy } from "@temporalio/client";
import { loadConfig } from "../bootstrap/config.js";
import { QUEUES } from "../contracts/index.js";
import { validateInput } from "../contracts/fingerprint.js";
import { makeFixture } from "./fixture.js";

async function main() {
  const config = loadConfig(process.env);
  const id = process.argv[2];
  if (!id)
    throw new Error(
      "Pass a stable submission ID, e.g. pnpm submit sample-001. Use a NEW ID only for a NEW observation.",
    );
  const input = validateInput(makeFixture(id));
  const connection = await Connection.connect({ address: config.address });
  try {
    const client = new Client({ connection, namespace: config.namespace });
    const handle = await client.workflow.start("SingleFilePilot", {
      taskQueue: QUEUES.workflow,
      workflowId: `p0-${input.requestId}`,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      args: [input],
    });
    console.log(
      JSON.stringify({
        workflowId: handle.workflowId,
        mode: "mock-local-only",
      }),
    );
    // Submission returns promptly; it does not occupy a worker waiting for completion.
  } finally {
    await connection.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Submission failed");
  process.exitCode = 1;
});
