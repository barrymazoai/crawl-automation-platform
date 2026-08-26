import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BACKEND_MODE: z.enum(["control-plane", "proxy"]).default("control-plane"),
  DATABASE_URL: z.string().optional(),
  CONTROL_PLANE_URL: z.url().optional(),
  CONTROL_PLANE_PROXY_URL: z.url().optional(),
  ADMIN_API_TOKEN: z.string().min(24),
  BROWSER_NODE_TOKEN: z.string().min(24).optional(),
  MAC_NODE_TOKEN: z.string().min(24).optional(),
  CAPTURE_WORKER_TOKEN: z.string().min(24).optional(),
  CLEAN_WORKER_TOKEN: z.string().min(24).optional(),
  LAN_UI_ENABLED: z.enum(["true", "false"]).default("false"),
  LEASE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  S3_ENDPOINT: z.url().optional(), S3_REGION: z.string().default("auto"), S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(), S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
});

export function loadConfig(env = process.env) {
  const value = schema.parse(env);
  if (value.BACKEND_MODE === "control-plane" && !value.DATABASE_URL) throw new Error("control-plane 模式必须配置 DATABASE_URL");
  if (value.BACKEND_MODE === "proxy" && !value.CONTROL_PLANE_URL) throw new Error("proxy 模式必须配置 CONTROL_PLANE_URL");
  const nodeTokens = new Map<string, readonly string[]>();
  const browserToken = value.BROWSER_NODE_TOKEN ?? value.CAPTURE_WORKER_TOKEN;
  const macToken = value.MAC_NODE_TOKEN ?? value.CLEAN_WORKER_TOKEN;
  if (browserToken) nodeTokens.set(browserToken, ["browser"]);
  if (macToken) nodeTokens.set(macToken, ["amazon", "process", "ingest", "cleanup"]);
  return {
    port: value.PORT, mode: value.BACKEND_MODE, databaseUrl: value.DATABASE_URL,
    controlPlaneUrl: value.CONTROL_PLANE_URL, controlPlaneProxyUrl: value.CONTROL_PLANE_PROXY_URL,
    adminToken: value.ADMIN_API_TOKEN,
    lanUiEnabled: value.LAN_UI_ENABLED === "true", leaseTtlSeconds: value.LEASE_TTL_SECONDS,
    nodeTokens,
    s3: value.S3_ENDPOINT && value.S3_BUCKET && value.S3_ACCESS_KEY_ID && value.S3_SECRET_ACCESS_KEY ? {
      endpoint: value.S3_ENDPOINT, region: value.S3_REGION, bucket: value.S3_BUCKET,
      forcePathStyle: value.S3_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId: value.S3_ACCESS_KEY_ID, secretAccessKey: value.S3_SECRET_ACCESS_KEY },
    } : null,
  };
}
