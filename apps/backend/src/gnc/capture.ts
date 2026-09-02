import fs from "node:fs/promises";
import path from "node:path";
import { createPageHolder, type BrowserTraffic, type PageHolder } from "../amazon/browser.js";
import type { SalesChannelNavigationRotation } from "../sales-channel-egress/types.js";
import { isGncCaptureIncomplete, isGncDiscoveryIncomplete } from "./completeness.js";
import { extractGncProduct, variantUrls, type ExtractedGncProduct, type RawGncPage } from "./extract.js";

export class GncAccessChallengeError extends Error {
  constructor(url: string, status: number) {
    super(`GNC 访问被 PerimeterX 挑战拦截（HTTP ${status || "unknown"}）：${url}`);
    this.name = "GncAccessChallengeError";
  }
}

export function isGncAccessChallenge(status: number, denied: boolean) {
  return denied || status === 406;
}

export const GNC_DISCOVERY_SCRIPT = `(() => {
  const bodyText = document.body?.innerText || '';
  const number = (value) => value ? Number.parseInt(value.replace(/,/g, ''), 10) : null;
  const progress = bodyText.match(/(\\d[\\d,]*)\\s+of\\s+(\\d[\\d,]*)/i);
  const resultCount = bodyText.match(/(\\d[\\d,]*)\\s+Results?\\b/i);
  const next = document.querySelector('.load-more-btn[data-grid-url], [data-grid-url][class*="load-more" i], a[rel="next"]');
  const html = document.documentElement.innerHTML;
  return {
    denied: /Access to this page has been denied|Pardon Our Interruption|Press & Hold|captcha/i.test(bodyText)
      || /px-captcha|perimeterx|_pxCaptcha/i.test(html),
    // 两类商品链接：6 位数字 SKU（单品/口味），以及商品卡片里的母产品链接（字母 ID，如
    // /energy-drinks/alaniNuEnergyCase.html——饮料、RTD、蛋白棒多为母产品，进去后 ProductGroup 会给出全部口味 SKU）。
    productLinks: [...new Set([
      ...[...document.querySelectorAll('a[href]')].map((node) => node.href).filter((href) => /\\/[0-9]{6}\\.html(?:$|[?#])/.test(href)),
      // 原始 HTML（ScraperAPI 不渲染）里卡片链接是 a.thumb-link / a.link，别依赖渲染后才有的类名
      ...[...document.querySelectorAll('.product-tile a[href]')]
        .map((node) => node.href).filter((href) => /\\/[^/?#]+\\.html(?:$|[?#])/.test(href) && !/\\/search\\b|demandware\\.store/.test(href)),
    ])],
    nextUrl: next?.getAttribute('data-grid-url') || next?.getAttribute('href') || null,
    expectedCount: number(progress?.[2]) ?? number(resultCount?.[1]),
    visibleCount: number(progress?.[1]),
  };
})()`;

export const GNC_PRODUCT_SCRIPT = `(() => {
  const bodyText = document.body?.innerText || '';
  const html = document.documentElement.innerHTML;
  const parse = (node) => { try { return JSON.parse(node.textContent || 'null'); } catch { return null; } };
  const objects = [];
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    objects.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  [...document.querySelectorAll('script[type="application/ld+json"]')].map(parse).filter(Boolean).forEach(visit);
  const hasType = (value, wanted) => (Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']]).includes(wanted);
  const pathSku = location.pathname.match(/\\/(\\d{6})\\.html$/)?.[1] || null;
  const products = objects.filter((value) => hasType(value, 'Product'));
  const groups = objects.filter((value) => hasType(value, 'ProductGroup'));
  const product = products.find((value) => String(value.sku || '') === pathSku) || products[0] || null;
  const group = groups.find((value) => Array.isArray(value.hasVariant) && value.hasVariant.some((item) => String(item?.sku || '') === pathSku)) || groups[0] || null;
  const analyticsValues = [...document.querySelectorAll('[data-gtmdata]')].map((node) => { try { return JSON.parse(node.getAttribute('data-gtmdata')); } catch { return null; } }).flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
  const analytics = analyticsValues.find((value) => String(value?.item_id || '') === pathSku)
    || analyticsValues.find((value) => typeof value?.item_url === 'string' && value.item_url.includes('/' + pathSku + '.html'))
    || analyticsValues.find((value) => value && value.item_id)
    || null;
  const variantRoots = [...document.querySelectorAll('.product-variations, .variation-attribute, [data-attribute-id], [class*="variation-attribute" i], [class*="swatch" i]')];
  const variantValues = variantRoots.flatMap((root) => [...root.querySelectorAll('a[href], [data-url], [data-href], [data-product-url]')].flatMap((node) => [
    node.getAttribute('href'), node.getAttribute('data-url'), node.getAttribute('data-href'), node.getAttribute('data-product-url'),
  ])).filter((value) => value && /\\/[0-9]{6}\\.html(?:$|[?#])/.test(value));
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const detailRoot = document.querySelector('#productDetailsAccordionContent');
  const howToUseRoot = document.querySelector('#productHowToUseAccordionContent');
  const details = [
    detailRoot ? 'DETAILS ACCORDION\\n' + clean(detailRoot.textContent) : '',
    howToUseRoot ? 'HOW TO USE ACCORDION\\n' + clean(howToUseRoot.textContent) : '',
  ].filter((value) => value.length > 10);
  if (details.length === 0) {
    details.push(...[...document.querySelectorAll('[id*="detail" i],[class*="benefit" i],[id*="benefit" i],[class*="direction" i],[id*="direction" i]')]
      .map((node) => clean(node.textContent)).filter((value) => value.length > 10));
  }
  const ingredientRoot = document.querySelector('#productIngredientsAccordionContent');
  const factRoots = ingredientRoot ? [ingredientRoot] : [...document.querySelectorAll('[id*="ingredient" i],[class*="ingredient" i],[id*="nutrition" i],[class*="nutrition" i],[id*="supplement" i],[class*="supplement" i],[id*="facts" i],[class*="facts" i]')];
  const factTables = [...new Set(factRoots.flatMap((root) => [...root.querySelectorAll('table')])
    .filter((table) => !table.querySelector('table'))
    .map((table) => [...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('th,td')]
      .map((cell) => clean(cell.textContent)).filter(Boolean).join(' | ')).filter(Boolean).join('\\n'))
    .filter((value) => value.length > 20))];
  const ingredientText = factRoots.map((node) => clean(node.textContent)).filter((value) => value.length > 20);
  const facts = [
    ...factTables.map((value) => 'HTML FACTS TABLE\\n' + value),
    ...ingredientText.map((value) => 'INGREDIENTS ACCORDION\\n' + value),
  ];
  return {
    url: location.href,
    title: document.title,
    diagnosticText: bodyText.replace(/\\s+/g, ' ').trim().slice(0, 1000),
    capturedAt: new Date().toISOString(),
    denied: /Access to this page has been denied|Pardon Our Interruption|Press & Hold|captcha/i.test(bodyText)
      || /px-captcha|perimeterx|_pxCaptcha/i.test(html),
    product,
    group,
    analytics,
    variantUrls: [...new Set(variantValues.map((value) => new URL(value, location.href).toString()))],
    pdfLinks: [...new Set([...document.querySelectorAll('a[href]')].map((node) => node.href).filter((href) => /\\.pdf(?:$|\\?)/i.test(href)))],
    imageUrls: [...new Set([...document.images].map((node) => node.currentSrc || node.src).filter((src) => /Sites-master-catalog-gnc|\\/hi-res\\//i.test(src)))].slice(0, 80),
    detailText: [...new Set(details)].join('\\n').slice(0, 60000),
    factsText: [...new Set(facts)].join('\\n').slice(0, 30000),
  };
})()`;

interface GncDiscoveryPage {
  denied: boolean;
  productLinks: string[];
  nextUrl: string | null;
  expectedCount: number | null;
  visibleCount: number | null;
}

export interface GncDiscoveryResult {
  urls: string[];
  pageCount: number;
  expectedCount: number | null;
  exhausted: boolean;
  truncated: boolean;
  nextUrl: string | null;
}

export interface GncCaptureResult {
  products: ExtractedGncProduct[];
  processedUrlCount: number;
  queuedUrlCount: number;
  /** 被 shouldSkip 跳过（库里最近已有）的 URL 数，不发请求。 */
  skippedCount: number;
  truncated: boolean;
}

export interface GncBrowserCrawlOptions {
  url: string;
  /** 取数层工厂。默认用浏览器；配了 ScraperAPI 就传它的 holder，过 PerimeterX。 */
  holderFactory?: () => PageHolder;
  jobDirectory: string;
  maxItems: number;
  signal: AbortSignal;
  rotation?: SalesChannelNavigationRotation;
  onNavigation?: (event: { kind: "catalog" | "product"; url: string; status: number; traffic: BrowserTraffic; denied: boolean }) => void | Promise<void>;
  /** v2：每成功抓到一个商品（含缓存命中）立即回调，用于边抓边发布 Batch。 */
  onProduct?: (product: ExtractedGncProduct) => void | Promise<void>;
  /** 跨 run 去重：返回 true 则不发请求（例如库里最近已见过这个 SKU）。同 run 内的断点缓存在此之前判断。 */
  shouldSkip?: (sku: string, url: string) => boolean | Promise<boolean>;
  /**
   * 每真实抓取一个商品页后的额外等待（毫秒）。控制整体请求速率、避开站点风控。
   * 缓存命中的商品不等待——那次没有发出请求。
   */
  productDelayMs?: number;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("GNC pipeline aborted");
}

/** 可被中断信号立即打断的等待，避免停 worker 时还要干等一整个延迟。 */
function sleep(ms: number, signal: AbortSignal) {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function writeJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function readJson<T>(filename: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(filename, "utf8")) as T; }
  catch { return null; }
}

function isProductUrl(url: string) {
  return /\.html(?:$|[?#])/i.test(new URL(url).pathname + new URL(url).search);
}

export async function discoverProductUrls(options: GncBrowserCrawlOptions) {
  if (isProductUrl(options.url)) {
    return { urls: [options.url], pageCount: 0, expectedCount: 1, exhausted: true, truncated: false, nextUrl: null } satisfies GncDiscoveryResult;
  }
  const holder = options.holderFactory ? options.holderFactory() : createPageHolder();
  const found = new Set<string>();
  const visited = new Set<string>();
  let next: string | null = options.url;
  let expectedCount: number | null = null;
  let exhausted = false;
  let truncated = false;
  try {
    while (next && !visited.has(next)) {
      assertNotAborted(options.signal);
      visited.add(next);
      const currentUrl: string = next;
      let page: { status: number; value: GncDiscoveryPage; traffic: BrowserTraffic };
      let failureAttempts = 0;
      while (true) {
        page = await holder.run(async (browser) => {
          const status = await browser.navigate(currentUrl);
          const value = await browser.evaluate<GncDiscoveryPage>(GNC_DISCOVERY_SCRIPT);
          return { status, value, traffic: browser.traffic() };
        });
        await options.onNavigation?.({ kind: "catalog", url: currentUrl, status: page.status, traffic: page.traffic, denied: page.value.denied });
        const challenge = isGncAccessChallenge(page.status, page.value.denied);
        const networkFailure = page.status === 0 && page.value.productLinks.length === 0 && page.value.expectedCount == null;
        if (!challenge && !networkFailure) break;
        if (!options.rotation || failureAttempts >= options.rotation.maxFailureRetries) {
          if (challenge) throw new GncAccessChallengeError(currentUrl, page.status);
          throw new Error(`GNC 目录页没有状态码且缺少目录证据：${currentUrl}`);
        }
        await holder.close();
        failureAttempts += 1;
        if (!await options.rotation.rotateAfterFailure(challenge ? "challenge" : "network")) {
          if (challenge) throw new GncAccessChallengeError(currentUrl, page.status);
          throw new Error(`GNC 所有 Sales Channel 出口均不可用：${currentUrl}`);
        }
      }
      // 404/410：品牌页不存在（GNC 有失效 slug）。当空目录正常收尾，不抛错——
      // 抛错会让任务失败重排、反复领、反复烧 ScraperAPI 额度。
      if (page.status === 404 || page.status === 410) { exhausted = true; break; }
      if (page.status >= 400) throw new Error(`GNC 目录页不可读 HTTP ${page.status}: ${currentUrl}`);
      if (page.status === 0 && page.value.productLinks.length === 0 && page.value.expectedCount == null) {
        throw new Error(`GNC 目录页没有状态码且缺少目录证据：${currentUrl}`);
      }
      if (page.value.expectedCount != null) expectedCount = Math.max(expectedCount ?? 0, page.value.expectedCount);
      for (const url of page.value.productLinks) found.add(new URL(url, currentUrl).toString());
      next = page.value.nextUrl ? new URL(page.value.nextUrl, currentUrl).toString() : null;
      if (!next) { exhausted = true; break; }
      if (found.size >= options.maxItems) { truncated = true; break; }
    }
  } finally { await holder.close(); }
  if (next && visited.has(next)) exhausted = false;
  truncated ||= isGncDiscoveryIncomplete({ foundCount: found.size, expectedCount, maxItems: options.maxItems, exhausted, nextUrl: next });
  return { urls: [...found].slice(0, options.maxItems), pageCount: visited.size, expectedCount, exhausted, truncated, nextUrl: next } satisfies GncDiscoveryResult;
}

export async function captureProducts(options: GncBrowserCrawlOptions, initial: string[]) {
  const directory = path.join(options.jobDirectory, "gnc", "captured");
  const holder = options.holderFactory ? options.holderFactory() : createPageHolder();
  const queued = [...initial];
  const knownUrls = new Set(queued);
  const bySku = new Map<string, ExtractedGncProduct>();
  let processedUrlCount = 0;
  let skippedCount = 0;
  let variantOverflow = false;
  try {
    for (let cursor = 0; cursor < queued.length && bySku.size < options.maxItems; cursor += 1) {
      assertNotAborted(options.signal);
      const url = queued[cursor]!;
      processedUrlCount += 1;
      const hintedSku = new URL(url).pathname.match(/\/(\d{6})\.html$/)?.[1];
      const cached = hintedSku ? await readJson<ExtractedGncProduct>(path.join(directory, `${hintedSku}.json`)) : null;
      if (cached?.capturedAt && typeof cached.factsText === "string") {
        if (!bySku.has(cached.sku)) await options.onProduct?.(cached);
        bySku.set(cached.sku, cached);
        continue;
      }
      // 母产品页抓出来的是默认口味 SKU，它随后又会以变体 URL 出现——同一 SKU 不再请求第二次
      if (hintedSku && bySku.has(hintedSku)) continue;
      if (hintedSku && options.shouldSkip && await options.shouldSkip(hintedSku, url)) { skippedCount += 1; continue; }
      if (options.rotation?.shouldRotateBeforeProduct()) {
        await holder.close();
        if (!await options.rotation.rotateAfterBatch()) throw new Error("GNC 没有可用的 Sales Channel 出口");
      }
      let raw: { status: number; value: RawGncPage; traffic: BrowserTraffic };
      let failureAttempts = 0;
      while (true) {
        raw = await holder.run(async (browser) => {
          const status = await browser.navigate(url);
          const value = await browser.evaluate<RawGncPage>(GNC_PRODUCT_SCRIPT);
          return { status, value, traffic: browser.traffic() };
        });
        await options.onNavigation?.({ kind: "product", url, status: raw.status, traffic: raw.traffic, denied: raw.value.denied });
        const challenge = isGncAccessChallenge(raw.status, raw.value.denied);
        const networkFailure = raw.status === 0 && !raw.value.product && !raw.value.group && !raw.value.analytics;
        if (!challenge && !networkFailure) break;
        if (!options.rotation || failureAttempts >= options.rotation.maxFailureRetries) {
          if (challenge) throw new GncAccessChallengeError(url, raw.status);
          throw new Error(`GNC 商品页没有状态码且缺少商品证据：${url}；title=${raw.value.title}；url=${raw.value.url}；text=${raw.value.diagnosticText.slice(0, 240)}`);
        }
        await holder.close();
        failureAttempts += 1;
        if (!await options.rotation.rotateAfterFailure(challenge ? "challenge" : "network")) {
          if (challenge) throw new GncAccessChallengeError(url, raw.status);
          throw new Error(`GNC 所有 Sales Channel 出口均不可用：${url}`);
        }
      }
      if (raw.status >= 400) throw new Error(`GNC 商品页不可读 HTTP ${raw.status}: ${url}`);
      if (raw.status === 0 && !raw.value.product && !raw.value.group && !raw.value.analytics) {
        throw new Error(`GNC 商品页没有状态码且缺少商品证据：${url}；title=${raw.value.title}；url=${raw.value.url}；text=${raw.value.diagnosticText.slice(0, 240)}`);
      }
      for (const variantUrl of variantUrls(raw.value)) {
        if (knownUrls.has(variantUrl)) continue;
        if (knownUrls.size >= options.maxItems) { variantOverflow = true; continue; }
        knownUrls.add(variantUrl);
        queued.push(variantUrl);
      }
      const product = extractGncProduct(raw.value);
      if (!product) throw new Error(`GNC 商品页缺少可验证 SKU、品牌或标题：${url}`);
      if (!bySku.has(product.sku)) await options.onProduct?.(product);
      bySku.set(product.sku, product);
      await writeJson(path.join(directory, `${product.sku}.json`), product);
      options.rotation?.recordProductSuccess();
      await sleep(options.productDelayMs ?? 0, options.signal);
    }
  } finally { await holder.close(); }
  const truncated = isGncCaptureIncomplete({
    processedUrlCount,
    queuedUrlCount: knownUrls.size,
    productCount: bySku.size,
    maxItems: options.maxItems,
    variantOverflow,
  });
  return { products: [...bySku.values()], processedUrlCount, queuedUrlCount: knownUrls.size, skippedCount, truncated } satisfies GncCaptureResult;
}
