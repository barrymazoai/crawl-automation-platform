import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { GncProductInputSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects } from "@crawl-automation/v3-artifacts";
import { CdpFileSession, createHttpRoute } from "@crawl-automation/v3-acquisition";
import { GncCaptureEvidence, GncProductPlans, GncFileSources, prepareGncFileGrant } from "@crawl-automation/v3-channels";
import { GncBrowserConfigSchema, GncFileWorkerConfigSchema, readGncPrivateJson } from "./gnc-config.js";

const Config = z.strictObject({ browser: GncBrowserConfigSchema, input: GncProductInputSchema,
  allowedOrigins: z.array(z.string()).min(1).max(10), expiresAt: z.iso.datetime(),
  fileWorker: GncFileWorkerConfigSchema.omit({ fileGrants: true }) });
async function main() {
  const path = process.env.V3_GNC_GRANT_CONFIG, output = process.env.V3_GNC_GRANT_OUTPUT;
  if (process.env.V3_GNC_SESSION_EXPORT_ENABLED !== "true" || !path || !output || !isAbsolute(output) || process.platform === "win32") throw Error();
  // Operator creates a private directory first. Never overwrite existing worker config or export to a shared directory.
  const parent = await lstat(dirname(output)); if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw Error();
  try { await lstat(output); throw Error("Output exists"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const config = Config.parse(await readGncPrivateJson(path));
  if (!equal(config.fileWorker.network, config.input.task.network) || config.browser.sessionId !== config.input.task.capture.binding.sessionId || config.input.task.network.mode === "host") throw Error();
  const route = createHttpRoute(config.fileWorker.network, config.fileWorker.proxyUrl ? { proxyUrl: config.fileWorker.proxyUrl } : {});
  const r2 = createR2Objects(config.fileWorker.r2, config.fileWorker.r2Credentials);
  const deny = async (): Promise<never> => { throw Error("Read-only provisioning"); };
  const evidence = new GncCaptureEvidence({ remote: { read: r2.store.read.bind(r2.store), create: deny },
    local: { read: deny, create: deny }, reviews: { read: deny, append: deny } });
  try {
    const plans = new GncProductPlans(evidence), browser = new CdpFileSession({ ...config.browser,
      egressId: config.input.task.network.egressId, allowedOrigins: config.allowedOrigins });
    const grant = await prepareGncFileGrant(plans, browser, config.input, config.allowedOrigins, config.expiresAt, AbortSignal.timeout(120000));
    new GncFileSources(plans, route, [grant]); // validate exactly the consumer's route and credential constraints before writing
    const result = GncFileWorkerConfigSchema.parse({ ...config.fileWorker, fileGrants: [grant] });
    const bytes = Buffer.from(JSON.stringify(result)); if (bytes.length > 4 * 1024 * 1024) throw Error();
    const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (!equal(await readGncPrivateJson(output), result)) throw Error();
    console.log(JSON.stringify({ event: "GNC_FILE_GRANT_WRITTEN", resources: grant.resources!.length }));
  } finally { r2.close(); }
}
main().catch(() => { console.error(JSON.stringify({ event: "GNC_FILE_GRANT_REJECTED" })); process.exitCode = 1; });
