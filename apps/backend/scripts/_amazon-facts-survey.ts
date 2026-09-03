/** 用现成的 Amazon 页面存档量一量：有多少页面能直接抠出完整成分表（不用 OCR）。只读，不改任何东西。 */
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { extractHtmlFacts } from "../src/dtc/html-facts.js";
import { hasCompleteFactsText } from "../src/gnc/facts.js";
const brotli = promisify(zlib.brotliDecompress);

const dir = process.argv[2]!;
const limit = Number(process.argv[3] ?? 300);
const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".html.br")).slice(0, limit);
let complete = 0, partial = 0, hintedImages = 0, none = 0, unreadable = 0;
const samples: string[] = [];
for (const name of files) {
  let html: string;
  try { html = (await brotli(await fs.readFile(path.join(dir, name)))).toString("utf8"); }
  catch { unreadable += 1; continue; }
  const out = extractHtmlFacts(html, `https://www.amazon.com/dp/${name.replace(".html.br", "")}`);
  if (out.factsText && hasCompleteFactsText(out.factsText)) {
    complete += 1;
    if (samples.length < 2) samples.push(`${name}\n${out.factsText.slice(0, 400)}`);
  } else if (out.factsText) partial += 1;
  else if (out.factsImageUrls.length) hintedImages += 1;
  else none += 1;
}
const n = files.length - unreadable;
const pct = (v: number) => `${((v / Math.max(n, 1)) * 100).toFixed(1)}%`;
console.log(`样本 ${n} 个页面（读不出 ${unreadable}）`);
console.log(`  完整成分表（可直接用，免 OCR）: ${complete}  ${pct(complete)}`);
console.log(`  有表格但不完整               : ${partial}  ${pct(partial)}`);
console.log(`  页面指认了成分表图片         : ${hintedImages}  ${pct(hintedImages)}`);
console.log(`  两者都没有                   : ${none}  ${pct(none)}`);
for (const s of samples) console.log(`\n样例:\n${s}`);
