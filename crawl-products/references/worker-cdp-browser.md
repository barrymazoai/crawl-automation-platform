# Browser Node 的 worker_cdp 模式

只在环境变量 `CRAWL_BROWSER_PROVIDER=worker_cdp` 时读取本页。该模式服务于自动领取 Railway capture Job 的 Windows Browser Node，不用于手工 Desktop 会话。

## 所有权边界

- Browser Node 控制器拥有 Chrome 生命周期、Railway 租约、心跳、批次上传和任务终态。
- 每个 Worker Lane 拥有一个独立 Chrome Profile、localhost CDP 端点和 Codex Runner；一个 Lane 同时只处理一个网站。
- Codex 只通过 `crawl-products/lib/worker-cdp-browser.mjs` 使用控制器已经启动的 Chrome。禁止另启 Chrome、调用 `agent.browsers`、访问 Railway 或读取节点 Token。
- `CRAWL_BROWSER_CDP_URL` 是控制器注入的 Lane 本地地址。不得改写、跨 Lane 共享或持久化到 Site Profile。

## 建立与恢复 binding

```js
globalThis.workerBrowser = globalThis.workerBrowser
  ?? await import(`${SKILL}/lib/worker-cdp-browser.mjs`);
globalThis.browserMode = "worker_cdp";
globalThis.crawlBrowser ??= await workerBrowser.connectWorkerBrowser();
globalThis.crawlProductsTab ??= await crawlBrowser.tabs.new();
globalThis.tab = crawlProductsTab;
globalThis.workerHooks = {
  fetchImage: workerBrowser.createBrowserImageFetcher(tab),
  fetchProductData: workerBrowser.createBrowserProductDataFetcher(tab),
};
```

tab 污染仍使用 `crawl.replaceTaintedTab()`。只有 `tabs.new()` 也失败才算 binding 丢失：断开旧 binding、重新 `connectWorkerBrowser()`、新建 tab，然后从落盘状态 resume。连接失败是执行面错误，不得解释成站点不可访问。

## Shopify 的双通道探测

先使用主机 HTTP 快速探测。返回 `null` 可能是“非 Shopify”，也可能是 Windows TLS、代理或证书链失败，不能直接作平台结论。worker_cdp 必须再走一次浏览器同源探测：

```js
let fetchJson;
let probe = await shopify.probeShopifyCatalog(entryUrl);
if (!probe) {
  await tab.goto(entryUrl);
  fetchJson = workerBrowser.createBrowserJsonFetcher(tab);
  probe = await shopify.probeShopifyCatalog(entryUrl, { fetchJson });
}
const built = probe && !probe.multiBrandRetailer
  ? await shopify.createShopifyHarvestHooks(entryUrl, { ...(fetchJson ? { fetchJson } : {}) })
  : null;
if (built) built.hooks.fetchImage = workerHooks.fetchImage;
```

两个通道都没有 Shopify 正信号时才进入视觉 Preflight。浏览器同源探测出现 challenge、登录墙或明确拒绝时，按站点访问证据分类，不能伪装成普通 `null`。

普通浏览器收割调用 `runHarvest()` 时也必须传入 `hooks: workerHooks`。这样变体 JSON 和原始图片都通过当前 Chrome 获取；Windows 主机的 Node TLS/代理失败不会再次造成 SKU 或图片证据缺失。图片下载会短暂把当前 tab 导航到原图 URL，必须保持单 tab 顺序纪律，下一条页面操作再显式导航到目标页。

## Capture 阶段边界

Browser Node 任务只生成 EvidenceBundleV1：展开每个可售变体、保留真实 SKU、保存正文/DOM/JSON/原始图片/必要截图并发布不可变批次。OCR、图片语义、最终 `productForm`/`healthFunctions`/`mainIngredients`、规范化和数据库入库全部留给 Mac Worker；不得在 Windows capture 阶段运行最终 enrich 导出。

结束前关闭本任务创建的 tab 并断开 Playwright CDP 客户端；不要关闭控制器拥有的 Chrome 进程。
