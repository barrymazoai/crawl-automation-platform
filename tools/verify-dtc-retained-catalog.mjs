// Direct Mini inspection of real saved pages, not a simulated browser or a unit test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { projectPage } from "../crawl-products/methods/catalog/natrol.mjs";

const [capture, output] = process.argv.slice(2);
if (!capture || !output) throw new Error("expected_retained_capture_new_output");
const root = resolve(capture);
await mkdir(resolve(output));
const require = createRequire(new URL("../crawl-products/package.json", import.meta.url));
const { parseHTML } = require("linkedom");
const discovery = JSON.parse(await readFile(join(root, "catalog-discovery.json"), "utf8"));
const sourceUrl = discovery.seedUrls[0];
assert.equal(sourceUrl, "https://www.natrol.com/collections/all-products");
const next = '#pagination .next-page:not([class~="!pointer-events-none"])';
const pages = [];
for (const page of discovery.pages) {
  const bytes = await readFile(join(root, page.htmlPath));
  const { document } = parseHTML(bytes.toString());
  const entries = projectPage({ document, url: page.url, sourceUrl });
  assert.deepEqual(new Set(entries.map(entry => entry.url)), new Set(page.productUrls));
  assert(entries.every(entry => entry.title && entry.brand === "Natrol"));
  pages.push({ url: page.url, htmlPath: page.htmlPath,
    sha256: createHash("sha256").update(bytes).digest("hex"), products: entries.length,
    currentPage: document.querySelector("#pagination nav")?.getAttribute("data-actual-page"),
    availableNextControls: document.querySelectorAll(next).length });
}
assert.deepEqual(pages.map(page => page.products), [24, 22]);
assert.deepEqual(pages.map(page => page.availableNextControls), [1, 0]);
const proof = { at: new Date().toISOString(), scope: "retained real HTML; live click and host completion remain separate", root, sourceUrl, pages };
await writeFile(join(resolve(output), "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
console.log(JSON.stringify(proof));
