import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";

await mkdir(resolve(".local"), { recursive: true });
const env = await TestWorkflowEnvironment.createLocal({
  server: {
    executable: { type: "cached-download", version: "v1.8.3" },
    ip: "127.0.0.1",
    port: 7239,
    ui: true,
    uiPort: 8239,
    dbFilename: resolve(".local/temporal-p0.sqlite"),
  },
});
console.log(
  "P0 local only: Temporal 127.0.0.1:7239; UI http://127.0.0.1:8239. No production services connected.",
);
try {
  await new Promise<void>((resolveStop) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolveStop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
} finally {
  await env.teardown();
}
