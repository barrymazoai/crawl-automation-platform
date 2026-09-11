import { isAbsolute } from "node:path";
import { z } from "zod";
import { DeliveryTarget } from "@crawl-automation/v3-contracts";
import { V3DatabaseUrl } from "./config.js";

const absolutePath = z.string().min(1).refine(isAbsolute);
const Profile = z.strictObject({
  target: DeliveryTarget,
  channelTargets: z.partialRecord(z.enum(["gnc", "amazon", "swanson", "dtc"]), DeliveryTarget).optional(),
  address: z.string().regex(/^[a-zA-Z0-9.-]+:[0-9]{1,5}$/).refine((s) => {
    const port = Number(s.split(":")[1]); return port > 0 && port <= 65535;
  }),
  transport: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("local") }),
    z.strictObject({ mode: z.literal("mtls"), serverName: z.string().min(1), caFile: absolutePath, certFile: absolutePath, keyFile: absolutePath }),
  ]),
  pauseFile: absolutePath,
  batchSize: z.number().int().min(1).max(100).default(20),
  concurrency: z.number().int().min(1).max(16).default(4),
  intervalMs: z.number().int().min(100).max(60_000).default(1000),
  shutdownMs: z.number().int().min(1000).max(120_000).default(45_000),
}).superRefine((v, ctx) => {
  if (v.channelTargets && (Object.keys(v.channelTargets).length === 0 || Object.values(v.channelTargets).some(t =>
    t.clusterId !== v.target.clusterId || t.namespace !== v.target.namespace || t.workflowType !== v.target.workflowType)))
    ctx.addIssue({ code: "custom", message: "Channel routes must share the configured cluster and workflow contract" });
  if (v.concurrency > v.batchSize) ctx.addIssue({ code: "custom", message: "Concurrency exceeds batch" });
  if (v.transport.mode === "local" && !["127.0.0.1", "localhost"].includes(v.address.split(":")[0]!))
    ctx.addIssue({ code: "custom", message: "Plaintext transport is loopback-only" });
});
export function deliveryConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.V3_DELIVERY_ENABLED !== "true" || !absolutePath.safeParse(env.V3_DELIVERY_CONFIG).success)
    throw new Error("Delivery is opt-in: V3_DELIVERY_ENABLED=true and absolute V3_DELIVERY_CONFIG are required");
  return env.V3_DELIVERY_CONFIG!;
}
export function parseDeliveryConfig(env: NodeJS.ProcessEnv, input: unknown) {
  deliveryConfigPath(env);
  return parseDeliverySettings(env.V3_DATABASE_URL, input);
}
export function parseDeliverySettings(databaseUrl: unknown, input: unknown) {
  const profile = Profile.safeParse(input);
  const database = V3DatabaseUrl.safeParse(databaseUrl);
  if (!profile.success || !database.success) throw new Error("Invalid isolated V3 delivery configuration; no credentials were logged");
  return { ...profile.data, databaseUrl: database.data };
}
