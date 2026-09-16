// Bundled probe: run the ScraperAPI Amazon capture path (route + reader) outside a Worker, on any machine.
//   node capture-probe.js <keyFile> <ASIN>
import { readFile } from "node:fs/promises";
import { createHttpRoute } from "@crawl-automation/v3-acquisition";
import { AmazonHttpReader } from "@crawl-automation/v3-channels";
const [keyFile, asin = "B009RT5NBG"] = process.argv.slice(2);
const apiKey = (await readFile(keyFile!, "utf8")).trim();
const route = { routeId: "scraperapi-us", version: "scraperapi/1", egressId: "scraperapi-us/1", mode: "scraperapi", managed: true, countryCode: "us", sessionNumber: null, responseMode: "html", providerPolicy: "scraperapi-sync/1" };
const http = createHttpRoute(route, { scraperApi: { apiKey, allowedOrigins: ["https://www.amazon.com"] } });
const t0 = Date.now();
try {
  let retained = 0;
  const r = await new AmazonHttpReader(http as never).product(`https://www.amazon.com/dp/${asin}`, AbortSignal.timeout(90000), async raw => { retained = JSON.stringify(raw).length; });
  console.log(JSON.stringify({ event: "PROBE_OK", seconds: Math.round((Date.now() - t0) / 1000), title: r.title?.slice(0, 60), parentAsin: (r as { parentAsin?: string }).parentAsin, fetchedVia: (r as { fetchedVia?: unknown }).fetchedVia, images: ((r as { imageCandidates?: unknown[] }).imageCandidates ?? []).length, retainedBytes: retained }));
} catch (error) {
  const e = error as { name?: string; message?: string; code?: string; cause?: { name?: string; message?: string; code?: string }; stack?: string };
  console.log(JSON.stringify({ event: "PROBE_FAILED", seconds: Math.round((Date.now() - t0) / 1000), name: e?.name, message: e?.message, code: e?.code, cause: e?.cause ? { name: e.cause.name, message: e.cause.message, code: e.cause.code } : null, stack: (e?.stack ?? "").split("\n").slice(1, 5) }));
}
