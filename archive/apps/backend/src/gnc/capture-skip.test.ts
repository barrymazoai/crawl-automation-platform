import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureProducts } from "./capture.js";
import { createScraperApiHolder } from "./scraperapi-page.js";

const PAD = `<!-- ${"x".repeat(6000)} -->`;
const productHtml = (sku: string) => `<html><body>
  <script type="application/ld+json">${JSON.stringify({ "@type": "Product", sku, name: `Item ${sku}`, brand: { name: "Bucked Up" }, offers: { price: "54.99", priceCurrency: "USD" } })}</script>
  <div id="productDetailsAccordionContent">Details for ${sku} — a pre-workout powder.</div>
  <div id="productIngredientsAccordionContent"><table><tr><td>Caffeine</td><td>200 mg</td></tr></table></div>
  </body></html>${PAD}`;

describe("captureProducts shouldSkip", () => {
  it("库里最近见过的 SKU 不发请求，其余照抓；跳过数进结果", async () => {
    const fetched: string[] = [];
    const holderFactory = () => createScraperApiHolder({
      apiKey: "test",
      fetchImpl: (async (input: string | URL | Request) => {
        const target = new URL(String(input)).searchParams.get("url")!;
        fetched.push(target);
        const sku = target.match(/\/(\d{6})\.html/)![1]!;
        return new Response(productHtml(sku), { status: 200, headers: { "content-type": "text/html" } });
      }) as typeof fetch,
    });
    const jobDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gnc-skip-"));
    const seen = new Set(["500954"]);
    const result = await captureProducts({
      url: "https://www.gnc.com/brands/bucked-up/", jobDirectory, maxItems: 50, holderFactory, signal: new AbortController().signal,
      shouldSkip: (sku) => seen.has(sku),
    }, ["https://www.gnc.com/x/500954.html", "https://www.gnc.com/x/501014.html"]);

    expect(fetched).toEqual(["https://www.gnc.com/x/501014.html"]);
    expect(result.skippedCount).toBe(1);
    expect(result.processedUrlCount).toBe(2);
    expect(result.truncated).toBe(false);
  });
});

describe("母产品页", () => {
  it("母页抓到默认口味后，同一 SKU 的变体 URL 不再请求；其他变体照抓", async () => {
    const fetched: string[] = [];
    const masterHtml = `<html><body>
      <script type="application/ld+json">${JSON.stringify([
        { "@type": "Product", sku: "561623", name: "Energy Drink - Witch's Brew", brand: { name: "Alani Nu" }, offers: { price: "29.99", priceCurrency: "USD" } },
        { "@type": "ProductGroup", hasVariant: [
          { "@type": "Product", sku: "561623", offers: { url: "https://www.gnc.com/energy-drinks/561623.html" } },
          { "@type": "Product", sku: "561624", offers: { url: "https://www.gnc.com/energy-drinks/561624.html" } },
        ] },
      ])}</script>
      <div id="productDetailsAccordionContent">Energy drink details here.</div>
      <div id="productIngredientsAccordionContent"><table><tr><td>Caffeine</td><td>200 mg</td></tr></table></div>
      </body></html>${PAD}`;
    const holderFactory = () => createScraperApiHolder({
      apiKey: "test",
      fetchImpl: (async (input: string | URL | Request) => {
        const target = new URL(String(input)).searchParams.get("url")!;
        fetched.push(target);
        const sku = target.match(/\/(\d{6})\.html/)?.[1];
        return new Response(sku ? productHtml(sku) : masterHtml, { status: 200, headers: { "content-type": "text/html" } });
      }) as typeof fetch,
    });
    const jobDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gnc-master-"));
    const result = await captureProducts({
      url: "https://www.gnc.com/brands/alani-nu/", jobDirectory, maxItems: 50, holderFactory, signal: new AbortController().signal,
    }, ["https://www.gnc.com/energy-drinks/alaniNuEnergyCase.html"]);
    expect(fetched).toEqual(["https://www.gnc.com/energy-drinks/alaniNuEnergyCase.html", "https://www.gnc.com/energy-drinks/561624.html"]);
    expect(result.products.map((p) => p.sku).sort()).toEqual(["561623", "561624"]);
  });
});
