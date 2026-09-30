/** 端到端验证：ScraperAPI 拉 GNC 页 → adapter → 跑 GNC 提取脚本，看能否提出商品。 */
import { GNC_DISCOVERY_SCRIPT, GNC_PRODUCT_SCRIPT } from "../src/gnc/capture.js";
import { createScraperApiPage } from "../src/gnc/scraperapi-page.js";

async function main() {
  const key = process.argv[2]!;
  const page = createScraperApiPage({ apiKey: key, countryCode: "us", log: (e) => console.error(JSON.stringify(e)) });

  console.log("=== 1. 品牌列表页：提取商品链接 ===");
  const s1 = await page.navigate("https://www.gnc.com/brands/bucked-up/");
  console.log(`  navigate HTTP ${s1}`);
  const disc: any = await page.evaluate(GNC_DISCOVERY_SCRIPT);
  console.log(`  被拦=${disc.denied} · 商品链接 ${disc.productLinks.length} 个 · expected=${disc.expectedCount}`);
  for (const u of disc.productLinks.slice(0, 3)) console.log(`    ${u}`);

  console.log("\n=== 2. 商品页：提取商品详情 ===");
  const productUrl = disc.productLinks[0] ?? "https://www.gnc.com/pre-workout-supplements/500465.html";
  const s2 = await page.navigate(productUrl);
  console.log(`  navigate HTTP ${s2}  ${productUrl}`);
  const prod: any = await page.evaluate(GNC_PRODUCT_SCRIPT);
  console.log(`  被拦=${prod.denied}`);
  console.log(`  product: ${prod.product ? `sku=${prod.product.sku} name=${String(prod.product.name).slice(0,40)}` : "null"}`);
  console.log(`  factsText 长度: ${(prod.factsText ?? "").length}`);
  console.log(`  factsText 前 120: ${(prod.factsText ?? "").slice(0, 120)}`);

  console.log(`\n  共消耗 ScraperAPI 请求: ${page.requestCount} 次`);
}
main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
