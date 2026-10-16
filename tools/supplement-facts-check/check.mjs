#!/usr/bin/env node
// Reads each gallery image of the listed products with our OCR service and records whether a Supplement Facts
// (or Nutrition / Drug Facts) panel is printed on it. It only finds candidates; formulas are still extracted by the
// normal label pipeline. Manual start, resumable, one OCR request at a time unless --lanes says otherwise.
//
//   node check.mjs <manifest.tsv> <runDir> [--ocr http://192.168.68.69:8081] [--lanes 1]
//   node check.mjs <manifest.tsv> <runDir> --summary      # rebuild products.tsv only
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const [manifestPath, runDir] = args;
if (!manifestPath || !runDir) {
  console.error("usage: node check.mjs <manifest.tsv> <runDir> [--ocr URL] [--lanes N] [--summary]");
  process.exit(2);
}
const ocrUrl = flag("--ocr", "http://192.168.68.69:8081").replace(/\/$/, "");
const lanes = Number(flag("--lanes", "1"));
const resultsPath = join(runDir, "images.jsonl");
mkdirSync(runDir, { recursive: true });

const rows = readFileSync(manifestPath, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => {
    const [channel, externalId, productId, imageSource, imageUrl] = line.split("\t");
    return { channel, externalId, productId, imageSource, imageUrl };
  })
  .filter((row) => row.imageUrl?.startsWith("http"));

/** Results already recorded; a download or OCR error is tried again on the next start. */
function readResults() {
  const done = new Map();
  if (!existsSync(resultsPath)) return done;
  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const result = JSON.parse(line);
    if (result.status === "ok" || result.status === "gone") done.set(result.imageUrl, result);
  }
  return done;
}

/** Headings and table words, read on letters only so OCR spacing does not matter. */
function detect(text) {
  const letters = text.toLowerCase().replace(/[^a-z]/g, "");
  return {
    supplementFacts: /supp?l?[eiy]?ments?facts?/.test(letters),
    nutritionFacts: /nutritionfacts?/.test(letters),
    drugFacts: /drugfacts?/.test(letters),
    servingSize: /servingsize/.test(letters),
    dailyValue: /dailyvalue/.test(letters),
  };
}

async function readImage(imageUrl) {
  const id = createHash("sha1").update(imageUrl).digest("hex").slice(0, 24);
  const download = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(30_000),
  });
  if (download.status === 404 || download.status === 410) return { status: "gone", http: download.status };
  if (!download.ok) return { status: "error", stage: "download", http: download.status };
  const bytes = await download.arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: download.headers.get("content-type") ?? "image/jpeg" }), "image");
  const jobId = `sfc-${id}-${Date.now()}`;
  try {
    const response = await fetch(`${ocrUrl}/ocr`, {
      method: "POST",
      body: form,
      headers: { "X-OCR-Job-Id": jobId },
      signal: AbortSignal.timeout(150_000),
    });
    const body = await response.json();
    if (!response.ok) return { status: "error", stage: "ocr", http: response.status, error: body.error };
    const lines = body.lines.map((line) => line.text);
    return {
      status: "ok",
      ...detect(body.text),
      factLines: lines.filter((line) => /fact/i.test(line)).slice(0, 5),
      lineCount: body.line_count,
      text: body.text,
    };
  } catch (error) {
    // Never leave our job running on the service after giving up on it.
    await fetch(`${ocrUrl}/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});
    return { status: "error", stage: "ocr", error: String(error).slice(0, 200) };
  }
}

function writeSummary() {
  const results = readResults();
  const products = new Map();
  for (const row of rows) {
    const key = `${row.channel}\t${row.externalId}`;
    const product = products.get(key) ?? {
      ...row,
      images: 0,
      read: 0,
      supplementFacts: [],
      nutritionFacts: [],
      drugFacts: [],
      panelWords: [],
    };
    product.images += 1;
    const result = results.get(row.imageUrl);
    if (result) {
      product.read += 1;
      if (result.supplementFacts) product.supplementFacts.push(row.imageUrl);
      if (result.nutritionFacts) product.nutritionFacts.push(row.imageUrl);
      if (result.drugFacts) product.drugFacts.push(row.imageUrl);
      if (!result.supplementFacts && result.servingSize && result.dailyValue) product.panelWords.push(row.imageUrl);
    }
    products.set(key, product);
  }
  const verdict = (p) =>
    p.supplementFacts.length
      ? "supplement-facts"
      : p.panelWords.length && !p.nutritionFacts.length
        ? "facts-table-no-heading"
        : p.drugFacts.length
          ? "drug-facts"
          : p.nutritionFacts.length
            ? "nutrition-facts"
            : p.read < p.images
              ? "unfinished"
              : "none";
  const header = "verdict\tchannel\texternal_id\tproduct_id\timages\tread\tfacts_images";
  const lines = [...products.values()].map((p) =>
    [
      verdict(p),
      p.channel,
      p.externalId,
      p.productId,
      p.images,
      p.read,
      [...p.supplementFacts, ...p.panelWords, ...p.drugFacts, ...p.nutritionFacts].slice(0, 3).join(" "),
    ].join("\t"),
  );
  writeFileSync(join(runDir, "products.tsv"), [header, ...lines].join("\n") + "\n");
  const counts = {};
  for (const p of products.values()) counts[verdict(p)] = (counts[verdict(p)] ?? 0) + 1;
  console.log(JSON.stringify({ products: products.size, ...counts }));
}

if (args.includes("--summary")) {
  writeSummary();
  process.exit(0);
}

const done = readResults();
const queue = [...new Set(rows.map((row) => row.imageUrl))].filter((url) => !done.has(url));
console.log(JSON.stringify({ images: new Set(rows.map((r) => r.imageUrl)).size, done: done.size, todo: queue.length, ocrUrl, lanes }));
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

let finished = 0;
async function lane() {
  while (!stopping && queue.length) {
    const imageUrl = queue.shift();
    let result;
    try {
      result = await readImage(imageUrl);
    } catch (error) {
      result = { status: "error", stage: "download", error: String(error).slice(0, 200) };
    }
    appendFileSync(resultsPath, JSON.stringify({ imageUrl, at: new Date().toISOString(), ...result }) + "\n");
    finished += 1;
    if (finished % 100 === 0) console.log(`${new Date().toISOString()} ${finished} read, ${queue.length} left`);
  }
}
await Promise.all(Array.from({ length: lanes }, lane));
writeSummary();
console.log(stopping ? "stopped; start again to resume" : "finished");
