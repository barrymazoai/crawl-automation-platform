import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { temporalConnectionOptions } from "./connect-temporal.js";

describe("temporalConnectionOptions", () => {
  it("connects without TLS for an insecure transport", async () => {
    const options = await temporalConnectionOptions({
      address: "localhost:7233",
      namespace: "default",
      transport: { mode: "insecure" },
    });

    expect(options).toEqual({ address: "localhost:7233", connectTimeout: "15 seconds" });
  });

  it("reads the certificate files for mTLS", async () => {
    const folder = await mkdtemp(join(tmpdir(), "platform-temporal-"));
    const file = async (name: string, text: string) => {
      const path = join(folder, name);
      await writeFile(path, text);
      await chmod(path, 0o600);
      return path;
    };
    const transport = {
      mode: "mtls" as const,
      serverName: "temporal.local",
      caFile: await file("ca.pem", "CA"),
      certFile: await file("cert.pem", "CERT"),
      keyFile: await file("key.pem", "KEY"),
    };

    const options = await temporalConnectionOptions({
      address: "temporal.test:7233",
      namespace: "crawler",
      transport,
    });

    expect(options.tls).toEqual({
      serverNameOverride: "temporal.local",
      serverRootCACertificate: Buffer.from("CA"),
      clientCertPair: { crt: Buffer.from("CERT"), key: Buffer.from("KEY") },
    });
  });
});
