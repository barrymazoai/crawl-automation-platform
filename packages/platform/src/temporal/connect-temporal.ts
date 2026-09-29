import { readFile } from "node:fs/promises";
import { Client, Connection, type ConnectionOptions } from "@temporalio/client";
import type { TemporalConfig } from "../config/schemas.js";

export interface TemporalClient {
  client: Client;
  close(): Promise<void>;
}

/** Builds the connection options, reading the mTLS files when the transport needs them. */
export async function temporalConnectionOptions(
  config: TemporalConfig,
): Promise<ConnectionOptions> {
  const transport = config.transport;
  if (transport.mode === "insecure") {
    return { address: config.address, connectTimeout: "15 seconds" };
  }
  const [serverRootCACertificate, crt, key] = await Promise.all([
    readFile(transport.caFile),
    readFile(transport.certFile),
    readFile(transport.keyFile),
  ]);
  return {
    address: config.address,
    connectTimeout: "15 seconds",
    tls: {
      serverNameOverride: transport.serverName,
      serverRootCACertificate,
      clientCertPair: { crt, key },
    },
  };
}

/** The one place that connects to Temporal as a client (starting, cancelling and inspecting workflows). */
export async function connectTemporal(config: TemporalConfig): Promise<TemporalClient> {
  const connection = await Connection.connect(await temporalConnectionOptions(config));
  return {
    client: new Client({ connection, namespace: config.namespace }),
    close: () => connection.close(),
  };
}
