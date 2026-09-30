import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { GncAcquireInputSchema, NetworkRouteSchema } from "@crawl-automation/v3-contracts";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { GncFileGrantsSchema } from "@crawl-automation/v3-channels";
import { EgoBrowserConfigSchema, EgoFileConfigSchema } from "@crawl-automation/v3-acquisition";
const base = { journalRoot: z.string().refine(isAbsolute), r2: R2ScopeSchema,
  r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  reviewDatabase: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }) };
export const GncBrowserConfigSchema = z.strictObject({ endpoint: z.string().max(512), instanceId: z.string().max(100), sessionId: z.string().min(1).max(200) });
const capture = { ...base, network: NetworkRouteSchema, browser: z.union([GncBrowserConfigSchema, EgoBrowserConfigSchema]),
  grants: z.array(z.strictObject({ task: GncAcquireInputSchema, expiresAt: z.iso.datetime() })).max(1000) };
export const GncFileWorkerConfigSchema = z.strictObject({ ...base, role: z.literal("gnc-file"), cacheRoot: z.string().refine(isAbsolute),
  network: NetworkRouteSchema, proxyUrl: z.string().max(4096).optional(), ego: EgoFileConfigSchema.optional(), fileGrants: GncFileGrantsSchema });
export const GncWorkerConfigSchema = z.discriminatedUnion("role", [z.strictObject({ ...capture, role: z.literal("gnc-catalog") }),
  z.strictObject({ ...capture, role: z.literal("gnc-product"), nativeMouse: z.strictObject({
    browserPid: z.number().int().positive(), profilePath: z.string().refine(isAbsolute), keepChallengeOpen:z.boolean().optional(),
  }).optional() }), z.strictObject({ ...base, role: z.literal("gnc-receipt") }),
  z.strictObject({ ...base, role: z.literal("gnc-product-input") }),
  z.strictObject({ ...base, role: z.literal("gnc-discovery") }), GncFileWorkerConfigSchema]);
export async function readGncPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw Error("Private absolute config required");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error("Private config required");
    const bytes = Buffer.alloc(stat.size + 1); let n = 0;
    while (n < bytes.length) { const r = await handle.read(bytes, n, bytes.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
    if (n !== stat.size) throw Error("Config changed");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n)));
  } finally { await handle.close(); }
}
