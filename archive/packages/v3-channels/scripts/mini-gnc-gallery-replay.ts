import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, isAbsolute } from "node:path";
import { sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { GncAcquireOutcomeSchema } from "@crawl-automation/v3-contracts";
import { parseGncProduct } from "../src/gnc.js";

// Offline acceptance only. Never publishes a replacement capture completion or changes an existing plan.
async function main() {
  const [root] = process.argv.slice(2);
  if (!root || !isAbsolute(root) || !/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("MINI_ONLY");
  const original = JSON.parse(await readFile(join(root, "capture-report.json"), "utf8"));
  const receipt = GncAcquireOutcomeSchema.parse(original.result);
  if (receipt.status !== "durable") throw Error("CAPTURE_NOT_DURABLE");
  const bytes = await readFile(join(root, "rendered.html")); verifyBytes(receipt.source, bytes, 2097152);
  const data = parseGncProduct(new TextDecoder("utf8", { fatal: true }).decode(bytes), "https://www.gnc.com/energy/613701.html", "613701");
  const report = { mode: "offline-reparse-not-published", sourceSha256: sha256(bytes), originalReceipt: receipt, data,
    networkCalls: 0, r2Calls: 0, modelCalls: 0, imageBytesVerified: false, productCollected: false };
  await writeFile(join(root, "gallery-replay.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: report.mode, images: data.imageCandidates.map(i => i.url), sourceSha256: report.sourceSha256 }));
}
main().catch(() => { console.error("GALLERY_REPLAY_UNVERIFIED"); process.exitCode = 1; });
