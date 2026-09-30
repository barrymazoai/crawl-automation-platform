/**
 * 不花 ScraperAPI 额度：把一份已保存的 ScraperAPI 返回页喂给 linkedom 适配器，
 * 跑 GNC 的目录/商品脚本，看 denied 判定与抽取结果。
 * 用法：npx tsx scripts/scraperapi-offline-check.ts <html 文件> <原始 url>
 */
import fs from "node:fs";
import { createScraperApiPage } from "../src/gnc/scraperapi-page.js";
import { GNC_DISCOVERY_SCRIPT, GNC_PRODUCT_SCRIPT } from "../src/gnc/capture.js";

const [file, url] = process.argv.slice(2);
const html = fs.readFileSync(file!, "utf8");
const page = createScraperApiPage({
  apiKey: "offline",
  fetchImpl: (async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch,
});
const status = await page.navigate(url!);
const discovery = await page.evaluate<any>(GNC_DISCOVERY_SCRIPT);
console.log("status", status, "denied", discovery.denied, "productLinks", discovery.productLinks.length, "expected", discovery.expectedCount, "next", discovery.nextUrl);
const bodyText: string = await page.evaluate("document.body.innerText");
const m = bodyText.match(/.{0,60}(Access to this page has been denied|Pardon Our Interruption|Press & Hold|captcha).{0,60}/i);
console.log("innerText 命中片段:", m ? JSON.stringify(m[0]) : "无");
console.log("innerText 长度", bodyText.length, "；其中 <script> 文本占比:", (await page.evaluate<number>("[...document.querySelectorAll('script')].reduce((n,s)=>n+s.textContent.length,0)")));
const product = await page.evaluate<any>(GNC_PRODUCT_SCRIPT);
console.log("product.denied", product.denied, "sku", product.product?.id ?? product.sku ?? null);
