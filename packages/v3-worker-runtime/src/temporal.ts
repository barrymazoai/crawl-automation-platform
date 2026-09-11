import { readFile } from "node:fs/promises";
import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { WorkerOptions } from "@temporalio/worker";
import type { WorkerConfig } from "./config.js";
import type { WorkerConnection } from "./lifecycle.js";

export async function connectTemporal(config: WorkerConfig): Promise<WorkerConnection> {
  const transport = config.transport;
  const tls = transport.mode === "mtls" ? {
    serverNameOverride: transport.serverName,
    serverRootCACertificate: await readFile(transport.caFile),
    clientCertPair: { crt: await readFile(transport.certFile), key: await readFile(transport.keyFile) },
  } : undefined;
  const options = { address: config.address, ...(tls ? { tls } : {}) };
  const client = await Connection.connect({ ...options, connectTimeout: "15 seconds" });
  try {
    await client.withDeadline(Date.now() + 5000, () => client.workflowService.describeNamespace({ namespace: config.namespace }));
  } finally { await client.close(); }
  const native = await NativeConnection.connect(options);
  return {
    create: async (prepared, role, settings, taskQueue, identity) => {
      const common: WorkerOptions = {
        connection: native, namespace: settings.namespace, taskQueue, identity, buildId: role.buildId,
        // Queue compatibility suffix is the current routing gate, not a claim to have enabled server Worker Versioning.
        useVersioning: false, shutdownGraceTime: settings.shutdownGraceMs, shutdownForceTime: settings.shutdownForceMs,
      };
      if (prepared.kind === "workflow") {
        return Worker.create({ ...common, workflowBundle: prepared.workflowBundle, activities: {}, enableNonLocalActivities: false,
          maxConcurrentWorkflowTaskExecutions: settings.concurrency, maxConcurrentWorkflowTaskPolls: 2,
          maxCachedWorkflows: 100 });
      }
      return Worker.create({ ...common, activities: prepared.activities,
        maxConcurrentActivityTaskExecutions: settings.concurrency, maxConcurrentActivityTaskPolls: Math.min(2, settings.concurrency) });
    },
    close: () => native.close(),
  };
}
