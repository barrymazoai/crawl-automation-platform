// Drives the bridge the way the Codex capture step does: connectWorkerBrowser with a task file
// bound to one owned page, then goto / evaluate / HTML fetch / Shopify JSON / image bytes / CDP events.
import { writeFile, mkdir } from 'node:fs/promises';
import { connectWorkerBrowser, createBrowserHtmlFetcher, createBrowserImageFetcher, createBrowserProductDataFetcher } from "../../crawl-products/lib/worker-cdp-browser.mjs";
const ep = process.argv[2], pause = process.argv[3];
const v = await (await fetch(new URL('/json/version', ep))).json();
const instanceId = v.webSocketDebuggerUrl.split('/').pop();
const marker = `about:blank#crawlv3-${crypto.randomUUID()}`;
const page = await (await fetch(new URL('/json/new?' + encodeURIComponent(marker), ep), { method: 'PUT' })).json();
const dir = new URL('./tasks/', import.meta.url).pathname; await mkdir(dir, { recursive: true });
const taskFile = dir + page.id + '.json';
await writeFile(taskFile, JSON.stringify({ endpoint: ep, instanceId, pauseFile: pause, targetId: page.id, expiresAt: Date.now() + 600000 }), { mode: 0o600, flag: 'wx' });
process.env.CRAWL_BROWSER_TASK_FILE = taskFile;
const t = Date.now(); const step = (k, v) => console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`, k, typeof v === 'string' ? v.slice(0, 300) : JSON.stringify(v)?.slice(0, 300));
let ok = true;
try {
  const browser = await connectWorkerBrowser({ cdpUrl: ep, timeoutMs: 30000 });
  step('connected', browser.mode);
  const tabs = await browser.tabs.list(); step('tabs', tabs.length);
  const tab = tabs[0];
  const r = await tab.goto('https://shop.hmwmethod.com/collections/all', { waitUntil: 'domcontentloaded', timeoutMs: 45000 }); step('goto', r?.status?.());
  const links = await tab.playwright.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/products/"]')].map(a => a.href.split('?')[0]))]); step('productLinks', links.length);
  const cdp = await tab.capabilities.get('cdp');
  const html = await createBrowserHtmlFetcher(tab)(links[0] ?? 'https://shop.hmwmethod.com/'); step('htmlBytes', html.length);
  const data = await createBrowserProductDataFetcher(tab)(links[0]); step('productJson', { title: data?.title, variants: data?.variants?.length, images: data?.images?.length });
  const img = data?.images?.[0]?.src; if (img) { const b = await createBrowserImageFetcher(tab)(img.startsWith('//') ? 'https:' + img : img); step('image', { bytes: b.bytes.length, mime: b.mime }); }
  const ev = await cdp.readEvents({ afterSequence: 0, limit: 1000 }); step('networkEvents', { n: ev.events.length, first: ev.events[0]?.method });
  const tree = await cdp.send('Page.getFrameTree'); step('cdpSend', tree.frameTree.frame.url);
  const shot = await tab.screenshot({ type: 'png' }); step('screenshot', shot.length);
  await browser.disconnect(); step('disconnected', 'ok');
} catch (e) { ok = false; step('FAIL', String(e?.stack ?? e)); }
const close = await (await fetch(new URL('/json/close/' + page.id, ep))).text(); step('close', close);
process.exit(ok ? 0 : 1);
