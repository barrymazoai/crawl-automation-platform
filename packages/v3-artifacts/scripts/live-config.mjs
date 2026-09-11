import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";

// Explicit file only. Never source shell code or fall back to other credentials.
export async function loadConfig(path) {
  if (!path || !isAbsolute(path)) throw Error("CONFIG_ABSOLUTE_PATH_REQUIRED");
  let env;
  try { env = parseEnv(await readFile(path, "utf8")); }
  catch { throw Error("CONFIG_UNREADABLE"); }
  return parseConfig(env);
}

export function parseConfig(env) {
  const fields = ["ENDPOINT", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"];
  const families = ["S3_", "CLOUDFLARE_R2_"];
  const present = families.filter(prefix => fields.some(field => env[prefix + field]));
  if (present.length !== 1) throw Error(present.length ? "CONFIG_AMBIGUOUS_FAMILIES" : "CONFIG_S3_FIELDS_REQUIRED");
  const prefix = present[0];
  if (fields.some(field => !env[prefix + field])) throw Error("CONFIG_S3_FIELDS_REQUIRED");
  if (env[prefix + "REGION"] && env[prefix + "REGION"] !== "auto") throw Error("CONFIG_REGION_MUST_BE_AUTO");
  return {endpoint:env[prefix + "ENDPOINT"],bucket:env[prefix + "BUCKET"],
    credentials:{accessKeyId:env[prefix + "ACCESS_KEY_ID"],secretAccessKey:env[prefix + "SECRET_ACCESS_KEY"]}};
}

// Conservative: any potentially matching expiration blocks this acceptance run.
// Multipart abort rules do not delete completed objects. Unknown filters fail closed.
export function retentionCheck(rules, prefix) {
  const relevant = rules.filter(rule => rule.Status === "Enabled").filter(rule => {
    if (!rule.Expiration && !rule.NoncurrentVersionExpiration) return false;
    const filter = rule.Filter;
    const rulePrefix = filter?.Prefix ?? filter?.And?.Prefix ?? rule.Prefix ?? "";
    if (typeof rulePrefix !== "string") return true;
    return `${prefix}/`.startsWith(rulePrefix) || rulePrefix.startsWith(`${prefix}/`);
  });
  return { checked: true, enabledRules: rules.filter(r => r.Status === "Enabled").length,
    potentiallyExpiringRules: relevant.length, safeForAcceptance: relevant.length === 0 };
}
