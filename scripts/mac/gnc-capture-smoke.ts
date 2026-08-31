import fs from "node:fs/promises";
import path from "node:path";
import { captureProducts, discoverProductUrls } from "../../apps/backend/src/gnc/capture.js";

const url = process.argv[2];
const output = path.resolve(process.argv[3] ?? "/tmp/gnc-capture-smoke");
const maxItems = Number.parseInt(process.argv[4] ?? "500", 10);

if (!url || !Number.isInteger(maxItems) || maxItems < 1) {
  throw new Error("usage: pnpm exec tsx scripts/mac/gnc-capture-smoke.ts <gnc-url> [output-directory] [max-items]");
}

await fs.mkdir(output, { recursive: true });
const signal = AbortSignal.timeout(20 * 60_000);
const discovery = await discoverProductUrls({ url, jobDirectory: output, maxItems, signal });
if (discovery.truncated || !discovery.exhausted) {
  throw new Error(`catalog incomplete: ${JSON.stringify(discovery)}`);
}
const capture = await captureProducts({ url, jobDirectory: output, maxItems, signal }, discovery.urls);
if (capture.truncated) throw new Error(`variants incomplete: ${JSON.stringify(capture)}`);

console.log(JSON.stringify({
  output,
  discovery,
  capture: {
    processedUrlCount: capture.processedUrlCount,
    queuedUrlCount: capture.queuedUrlCount,
    productCount: capture.products.length,
    products: capture.products.map((product) => ({
      sku: product.sku,
      title: product.title,
      brand: product.brand,
      productUrl: product.productUrl,
      labelPdfUrl: product.labelPdfUrl,
      variantAttrs: product.variantAttrs,
    })),
  },
}, null, 2));
