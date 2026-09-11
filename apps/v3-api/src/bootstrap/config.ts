import { z } from "zod";
import { TemporalUi } from "@crawl-automation/v3-contracts";

export function loadTemporalUi(env: NodeJS.ProcessEnv) {
  try { return z.array(TemporalUi).max(10).parse(JSON.parse(env.V3_TEMPORAL_UI ?? "[]")); }
  catch { throw new Error("Invalid V3_TEMPORAL_UI cluster/baseUrl mapping"); }
}

export const V3DatabaseUrl = z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        ["127.0.0.1", "localhost"].includes(url.hostname) &&
        ["/crawler_v3_dev", "/crawler_v3_test"].includes(url.pathname) &&
        url.search === "" &&
        url.hash === ""
      );
    }, "Only an explicit local V3 database is accepted in this development slice");
const Config = z.strictObject({
  databaseUrl: V3DatabaseUrl,
  token: z.string().min(32).max(256),
  port: z.coerce.number().int().min(1024).max(65535),
});
export function loadConfig(env: NodeJS.ProcessEnv) {
  const result = Config.safeParse({
    databaseUrl: env.V3_DATABASE_URL,
    token: env.V3_API_TOKEN,
    port: env.V3_API_PORT ?? "4180",
  });
  if (!result.success)
    throw new Error(
      "Invalid V3 configuration: provide V3_DATABASE_URL for a local crawler_v3_dev/test database, V3_API_TOKEN (32+ chars) and a valid port. Old DATABASE_URL is never used.",
    );
  return result.data;
}
