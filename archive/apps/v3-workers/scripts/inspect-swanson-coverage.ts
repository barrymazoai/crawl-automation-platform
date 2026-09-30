import { readFile, writeFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { EgoTaskPages, EgoCliRunner } from "@crawl-automation/v3-acquisition";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { swansonCatalogProjectionExpression } from "../../../packages/v3-channels/src/swanson-catalog-rendered.js";

// Read-only, finite public storefront evidence; no model calls or product writes.
async function main() {
  if (!/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("MINI_REQUIRED");
  const [url, name, pick] = process.argv.slice(2);
  if(pick&&!/^\d+$/.test(pick))throw Error("PICK_REJECTED");
  if (!url || !name || !/^[a-z0-9-]+$/.test(name)) throw Error("ARGS_REQUIRED");
  const u = new URL(url);
  if (u.origin !== "https://www.swansonvitamins.com" || !/^\/(?:pages\/brands|collections\/brand-[a-z0-9-]+(?:\/p\/[a-z0-9-]+)?|p\/[a-z0-9-]+)$/.test(u.pathname) || u.hash || [...u.searchParams.keys()].some(k => !["page", "variant", "view"].includes(k))) throw Error("SCOPE_REJECTED");
  const root = "/Users/barry/apps/crawlv3-batch-a.UiA4dx", dir = root + "/live/swanson-coverage-20260910/" + name;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const manifest = JSON.parse(await readFile(root + "/live/deployment.json", "utf8"));
  if (new URL(manifest.database.connectionString).pathname !== "/crawler_v3_test") throw Error("TEST_DB_REQUIRED");
  const db = new pg.Pool({ connectionString: manifest.database.connectionString, max: 2 }), admission = new PostgresResourceAdmission(db);
  const id = "coverage-" + randomUUID(), permit = { permitId: "permit-" + id, workflowId: "manual-" + id, runId: randomUUID(), needs: [{ resourceId: "mini-ego-space-1", units: 1 }] };
  const pages = new EgoTaskPages({ engine: "ego-lite", sdk: "1", cliPath: "/Users/barry/.local/bin/ego-browser", taskSpaceId: 1 }, await TextLocalStore.open(join(dir, "journal")));
  const runner = new EgoCliRunner(), report: any = { id, url, permit, closed: false, released: false };
  try {
    if ((await admission.reserve(permit)).status !== "granted") throw Error("BROWSER_BUSY");
    report.held = true;
    await pages.using(id, AbortSignal.timeout(90000), async p => {
      // All fields are explicit public UI/product data. Never export raw HTML or window state.
      const expression = `(()=>{const visible=e=>!!(e.getBoundingClientRect().width&&e.getBoundingClientRect().height);
        const productJson=[...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(s=>{try{const d=JSON.parse(s.textContent);return(Array.isArray(d)?d:[d]).filter(x=>x['@type']==='Product').map(x=>({name:x.name,sku:x.sku,productID:x.productID,offers:x.offers}));}catch{return[];}});
        return {url:location.href,title:document.querySelector('h1')?.innerText,capturedAt:new Date().toISOString(),
          head:{canonical:document.querySelector('link[rel="canonical"]')?.href??null,ogUrl:document.querySelector('meta[property="og:url"]')?.content??null,ogType:document.querySelector('meta[property="og:type"]')?.content??null},
          catalog:document.querySelector('#ResultsList')?(${swansonCatalogProjectionExpression}):null,
          brands:[...document.querySelectorAll('.brand-item a')].map(a=>({name:a.innerText,url:a.href})),
          controls:[...document.querySelectorAll('main button,main select,main input,main a')].filter(visible).map(e=>({tag:e.tagName,text:e.innerText?.slice(0,300),name:e.getAttribute('name'),id:e.id,role:e.getAttribute('role'),ariaLabel:e.getAttribute('aria-label'),url:e.tagName==='A'?e.href:null,type:e.getAttribute('type'),value:['SELECT','INPUT'].includes(e.tagName)?e.value:null,options:e.tagName==='SELECT'?[...e.options].map(o=>({text:o.text,value:o.value})):null})).slice(0,300),
          forms:[...document.querySelectorAll('product-form-component[data-product-id]')].map(f=>({productId:f.getAttribute('data-product-id'),variants:[...f.querySelectorAll('[name="id"]')].map(i=>({tag:i.tagName,value:i.value,type:i.type})),text:f.innerText.slice(0,12000)})),
          optionMarkup:[...document.querySelectorAll('input[role="radio"]')].map(i=>({attributes:[...i.attributes].map(a=>[a.name,a.value]),parents:[i.parentElement,i.parentElement?.parentElement,i.parentElement?.parentElement?.parentElement].filter(Boolean).map(e=>({tag:e.tagName,attributes:[...e.attributes].map(a=>[a.name,a.value])}))})),
          pagination:[...document.querySelectorAll('nav')].filter(e=>/page/i.test(e.getAttribute('aria-label')||'')).map(e=>({label:e.getAttribute('aria-label'),text:e.innerText,links:[...e.querySelectorAll('a')].map(a=>({url:a.href,text:a.innerText,attributes:[...a.attributes].map(x=>[x.name,x.value])}))})),
          productJson,bodyText:document.querySelector('main')?.innerText?.slice(0,24000)};})()`;
      const choose=pick?`const before=await js('location.href');await js(${JSON.stringify(`(()=>{const a=[...document.querySelectorAll('input[role="radio"][data-variant-id]')].filter(i=>i.getAttribute('data-variant-id')===${JSON.stringify(pick)});if(a.length!==1)throw Error('CHOICE_UNVERIFIED');a[0].click();})()`)});
        let selected=false;for(let n=0;n<50;n++){const state=await js(${JSON.stringify(`(()=>{const f=[...document.querySelectorAll('product-form-component input[name="id"]')];return f.length===1&&f[0].value===${JSON.stringify(pick)};})()`)});if(state){selected=true;break;}await new Promise(r=>setTimeout(r,200));}if(!selected)throw Error('CHOICE_NOT_SETTLED');`:"";
      const script = `await useOrCreateTaskSpace(1);const tabs=await listTabs();if(!tabs.some(t=>t.targetId===${JSON.stringify(p.targetId)}))throw Error('TARGET_MISSING');await switchTab(${JSON.stringify(p.targetId)});await gotoAndWait(${JSON.stringify(url)},{timeout:20});${choose}const value=await js(${JSON.stringify(expression)});const image=await cdp('Page.captureScreenshot',{format:'png',fromSurface:false});const snapshot={value,image:image.data};`;
      const out = await runner.run(p.cliPath, script, AbortSignal.timeout(60000)) as any;
      await writeFile(join(dir, "public.json"), JSON.stringify(out.value, null, 2));
      await writeFile(join(dir, "page.png"), Buffer.from(out.image, "base64"));
      report.targetId = p.targetId;
    });
    report.closed = true;
    await admission.release(permit); report.released = true; report.held = false;
  } catch (e) { report.error = e instanceof Error ? e.message : "INSPECT_FAILED"; process.exitCode = 1; }
  finally { await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2)); await db.end(); console.log(JSON.stringify({ dir, ...report })); }
}
main().catch(() => { console.error("COVERAGE_INSPECT_REJECTED"); process.exitCode = 1; });
