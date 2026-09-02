/** 用 mini 上已解压的真实 Windows 证据包验证解析器：不重新下载。用法：npx tsx scripts/_win-bundle-check.ts <evidence 根目录> */
import fs from "node:fs/promises";
import path from "node:path";
import { readWindowsBundle, recordToProducts } from "../src/v2/dtc-capture.js";
const root = process.argv[2]!;
let total = 0; const skus = new Set<string>(); let withImages = 0; let withIngredients = 0;
for (const name of (await fs.readdir(root)).sort()) {
  const dir = path.join(root, name);
  const records = await readWindowsBundle(dir);
  if (!records) { console.log(name, "不是 Windows 包"); continue; }
  const products = records.flatMap((r) => recordToProducts(r, dir, new Date().toISOString()));
  total += products.length;
  for (const p of products) { if (p.sku) skus.add(p.sku); if (p.localImages.length) withImages += 1; if (p.detailText) withIngredients += 1; }
  console.log(`${name}: records ${records.length} → products ${products.length}; 样例: ${products[0]?.title.slice(0, 60)} | sku ${products[0]?.sku} | 本地图 ${products[0]?.localImages.length}`);
}
console.log(`合计 ${total} 个产品，${skus.size} 个不同 SKU，${withImages} 个带本地图片，${withIngredients} 个带成分/详情文本`);
