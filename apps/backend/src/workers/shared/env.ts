import path from "node:path";
import { z } from "zod";

/**
 * 可组合的环境变量片段：每个 worker 入口只声明自己真正需要的那几段。
 * 文字 Pool 不会解析 Chrome/代理相关变量，抓取入口也不会解析入库相关变量——
 * 配错了在启动时就报错，而不是等跑到一半才发现。
 */

export const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

/** 所有 worker 都需要：控制面地址、身份、并发、工作目录。 */
export const baseEnv = {
  CONTROL_PLANE_URL: z.url(),
  MAC_NODE_TOKEN: z.string().min(24),
  NODE_ID: z.string().min(3),
  NODE_NAME: z.string().default(""),
  NODE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  WORK_ROOT: z.string().default(path.resolve(".automation-runs")),
  LOCAL_STATE_DB: z.string().default(path.resolve(".automation-state/worker.sqlite")),
  REPOSITORY_ROOT: z.string().default(process.cwd()),
  DISK_SOFT_MIN_FREE_GB: z.coerce.number().min(1).max(1000).default(40),
  DISK_HARD_MIN_FREE_GB: z.coerce.number().min(1).max(1000).default(15),
} as const;

/** 需要调用模型的 worker（文字、图片、整合、以及要跑 Codex 的抓取入口）。 */
export const codexEnv = {
  CODEX_EXECUTABLE: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-5.6-luna"),
  CODEX_REASONING_EFFORT: z.string().default("medium"),
  CODEX_UNATTENDED_FULL_ACCESS: z.enum(["true", "false"]).default("false"),
  CODEX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  CODEX_USAGE_COMMAND: optionalSecret,
} as const;

/** 需要读产品库 / 写 Product Server / 调 OCR 的 worker。 */
export const productEnv = {
  PRODUCT_DATABASE_URL: z.string().min(1),
  PRODUCT_SERVER_URL: z.url(),
  PRODUCT_SERVER_TOKEN: optionalSecret,
  PRODUCT_SERVER_API_KEY: optionalSecret,
  OCR_ENDPOINT: z.url(),
  OCR_IMAGE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
} as const;

/** v2 处理线阶段共用的参数。 */
export const stageEnv = {
  GNC_PDF_RENDER_SCRIPT: z.string().default(path.resolve("scripts/mac/render-pdf-pages.swift")),
  // 方案 9：迁移期强制所有入库声明 partial，物理上杜绝缺席下架。
  FORCE_PARTIAL_SCOPE: z.enum(["true", "false"]).default("true"),
  REVIEW_ROOT: z.string().default(path.resolve(".automation-review")),
} as const;

/** 抓取入口共用：批量大小与单品牌上限。 */
export const captureEnv = {
  V2_CAPTURE_BATCH_SIZE: z.coerce.number().int().min(5).max(100).default(25),
  AMAZON_MAX_ITEMS: z.coerce.number().int().min(1).max(2000).default(500),
  GNC_MAX_ITEMS: z.coerce.number().int().min(1).max(5000).default(500),
  SWANSON_MAX_ITEMS: z.coerce.number().int().min(1).max(5000).default(2000),
} as const;

/** 需要真实浏览器的抓取入口（Amazon）。 */
export const browserEnv = {
  SALES_CHANNEL_CHROME_PROFILE_ROOT: z.string().default(path.resolve(".automation-state/chrome")),
  SALES_CHANNEL_CHROME_EXECUTABLE: z.string().optional(),
} as const;

/** 只有 GNC 抓取入口需要：Clash 出口轮动。 */
export const egressEnv = {
  SALES_CHANNEL_EGRESS_STATE_DB: z.string().default(path.resolve(".automation-state/sales-channel-egress.sqlite")),
  SALES_CHANNEL_EGRESS_PROFILE_ROOT: z.string().default(path.resolve(".automation-state/sales-channel-egress-chrome")),
  SALES_CHANNEL_CLASH_CONFIG_FILE: z.string().min(1),
  SALES_CHANNEL_CLASH_CONTROLLER_URL: z.url(),
  SALES_CHANNEL_PROXY_URL: z.url().optional(),
  GNC_EGRESS_POOL: z.string().min(1).default("us-residential-4"),
  GNC_EGRESS_SELECTOR: z.string().min(1).default("GNC出口"),
  GNC_EGRESS_EXITS: z.string().default("texas=美国德州ip,washington=美国华盛顿ip,los-angeles=美国洛杉矶ip,redmond=美国雷德蒙德ip"),
  GNC_EGRESS_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  GNC_EGRESS_CHALLENGE_COOLDOWN_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(600_000),
  GNC_EGRESS_NETWORK_FAILURE_COOLDOWN_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(120_000),
  GNC_EGRESS_MAX_FAILURE_RETRIES: z.coerce.number().int().min(1).max(20).default(4),
} as const;

/** 把若干片段合成一个 schema 并解析 process.env；返回类型是各片段的交集。 */
export function loadEnv<A extends z.ZodRawShape>(a: A): z.infer<z.ZodObject<A>>;
export function loadEnv<A extends z.ZodRawShape, B extends z.ZodRawShape>(a: A, b: B): z.infer<z.ZodObject<A & B>>;
export function loadEnv<A extends z.ZodRawShape, B extends z.ZodRawShape, C extends z.ZodRawShape>(a: A, b: B, c: C): z.infer<z.ZodObject<A & B & C>>;
export function loadEnv<A extends z.ZodRawShape, B extends z.ZodRawShape, C extends z.ZodRawShape, D extends z.ZodRawShape>(a: A, b: B, c: C, d: D): z.infer<z.ZodObject<A & B & C & D>>;
export function loadEnv(...shapes: z.ZodRawShape[]) {
  return z.object(Object.assign({}, ...shapes)).parse(process.env);
}

export function parseEgressExits(value: string) {
  const exits = value.split(",").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`invalid_sales_channel_egress_exit:${entry}`);
    const id = entry.slice(0, separator).trim();
    const proxyName = entry.slice(separator + 1).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !proxyName) throw new Error(`invalid_sales_channel_egress_exit:${entry}`);
    return { id, proxyName };
  });
  if (exits.length === 0) throw new Error("sales_channel_egress_exits_required");
  return exits;
}
