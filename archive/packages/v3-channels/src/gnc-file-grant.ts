import { isDeepStrictEqual as equal } from "node:util";
import { GncProductInputSchema, type GncProductInput } from "@crawl-automation/v3-contracts";
import { AcquisitionError, permittedUrl, type FileSessionExporter } from "@crawl-automation/v3-acquisition";
import { GncFileGrantsSchema } from "./gnc-files.js";
import type { GncProductPlans } from "./gnc-product.js";

/** Operator-side provisioning, NOT a Temporal activity result. Only published image tasks may receive credentials.
 * Return value goes to the file Worker's private config, never common evidence storage.
 */
export async function prepareGncFileGrant(plans: Pick<GncProductPlans, "inspect" | "fileSource">, browser: FileSessionExporter,
  raw: GncProductInput, allowedOrigins: string[], expiresAt: string, signal: AbortSignal) {
  try {
    const input = GncProductInputSchema.parse(raw);
    const initial = GncFileGrantsSchema.parse([{ input, allowedOrigins, expiresAt }])[0]!;
    if (Date.parse(expiresAt) <= Date.now() || browser.sessionId !== input.task.capture.binding.sessionId ||
      browser.egressId !== input.task.capture.binding.egressId) throw Error();
    for (const origin of initial.allowedOrigins) if (permittedUrl(origin, [origin]).origin !== origin) throw Error();
    const plan = await plans.inspect(input, signal);
    if (!plan || !equal(plan.input, input)) throw Error();
    const files = plan.manifest.sources.filter(s => s.kind === "file-image").map(s => s.plan.acquire);
    const urls: string[] = [];
    // Authorize the entire set before any CDP read; no caller-supplied image URLs.
    for (const file of files) urls.push(permittedUrl(await plans.fileSource(input, file, signal), allowedOrigins).href);
    signal.throwIfAborted();
    if (!files.length) return GncFileGrantsSchema.parse([{ ...initial, resources: [] }])[0]!;
    const snapshot = await browser.exportFiles(urls, input.task.capture.url, expiresAt, signal);
    if (snapshot.sessionId !== browser.sessionId || snapshot.egressId !== browser.egressId || snapshot.resources.length !== files.length) throw Error();
    const resources = files.map((file, i) => {
      const r = snapshot.resources[i]!;
      if (r.url !== urls[i] || Date.parse(r.expiresAt) > Date.parse(expiresAt) || Date.parse(r.expiresAt) <= Date.now()) throw Error();
      return { ...r, input: file };
    });
    signal.throwIfAborted();
    return GncFileGrantsSchema.parse([{ ...initial, resources }])[0]!;
  } catch { throw new AcquisitionError("SOURCE.SESSION_UNAVAILABLE"); }
}
