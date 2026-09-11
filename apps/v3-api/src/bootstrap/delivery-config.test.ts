import { describe, expect, it } from "vitest";
import { deliveryConfigPath, parseDeliveryConfig } from "./delivery-config.js";

const env = { V3_DELIVERY_ENABLED: "true", V3_DELIVERY_CONFIG: "/tmp/v3-delivery.json", V3_DATABASE_URL: "postgresql://test:secret@127.0.0.1:55432/crawler_v3_test" };
const profile = { target: { clusterId: "local-test", namespace: "default", taskQueue: "probe", workflowType: "Probe" },
  address: "127.0.0.1:7233", transport: { mode: "local" }, pauseFile: "/tmp/v3-delivery.pause" };
describe("explicit delivery process configuration", () => {
  it("accepts explicit channel queues only in the configured cluster and workflow",()=>{
    expect(parseDeliveryConfig(env,{...profile,channelTargets:{swanson:{...profile.target,taskQueue:"swanson"}}}).channelTargets?.swanson?.taskQueue).toBe("swanson");
    for(const channelTargets of [{},{unknown:profile.target},{swanson:{...profile.target,namespace:"other"}},{swanson:{...profile.target,workflowType:"Other"}}])
      expect(()=>parseDeliveryConfig(env,{...profile,channelTargets})).toThrow();
  });
  it("requires explicit opt-in and a file; never falls back to old environment variables", () => {
    expect(() => deliveryConfigPath({})).toThrow();
    expect(() => deliveryConfigPath({ ...env, V3_DELIVERY_CONFIG: "relative.json" })).toThrow();
    expect(() => parseDeliveryConfig({ ...env, V3_DATABASE_URL: undefined, DATABASE_URL: env.V3_DATABASE_URL }, profile)).toThrow();
    expect(parseDeliveryConfig(env, profile)).toMatchObject({ batchSize: 20, concurrency: 4, intervalMs: 1000, shutdownMs: 45000 });
  });
  it("rejects non-V3 databases, plaintext remote transport and unsafe settings", () => {
    expect(() => parseDeliveryConfig({ ...env, V3_DATABASE_URL: "postgresql://secret@127.0.0.1/old_prod" }, profile)).toThrow();
    for (const change of [{ address: "cloud.example:7233" }, { address: "127.0.0.1:99999" }, { concurrency: 0 },
      { batchSize: 1, concurrency: 2 }, { batchSize: 101 }, { pauseFile: "relative" }, { intervalMs: 0 }, { unexpected: true }]) {
      expect(() => parseDeliveryConfig(env, { ...profile, ...change })).toThrow();
    }
  });
  it("requires all explicit mTLS paths for a remote endpoint and does not log secret values", () => {
    const transport = { mode: "mtls", serverName: "temporal.test", caFile: "/tmp/ca.pem", certFile: "/tmp/client.pem", keyFile: "/tmp/key.pem" };
    expect(parseDeliveryConfig(env, { ...profile, address: "cloud.example:8443", transport }).transport.mode).toBe("mtls");
    expect(() => parseDeliveryConfig(env, { ...profile, transport: { ...transport, keyFile: undefined } })).toThrow();
    try { parseDeliveryConfig({ ...env, V3_DATABASE_URL: "secret-value" }, profile); }
    catch (error) { expect(String(error)).not.toContain("secret-value"); }
  });
});
