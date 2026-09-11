import { z } from "zod";
import { SwansonBrandDirectorySchema, SwansonRenderedProductSchema } from "@crawl-automation/v3-contracts";
import { EgoBrowserConfigSchema, EgoCliRunner, type EgoBrowserConfig, type EgoCommandRunner } from "@crawl-automation/v3-acquisition";
import { ChannelError } from "./html-evidence.js";
import { SWANSON_BRANDS_URL } from "./channel-brand.js";
import { swansonProductAddress } from "./swanson-rendered.js";
import { SwansonCatalogProjectionSchema,swansonCatalogAddress,swansonCatalogProjectionExpression,parseSwansonRenderedCatalog } from "./swanson-catalog-rendered.js";

const common = `url:location.href,capturedAt:new Date().toISOString()`;
const directory = `(() => { const search=document.querySelector('#brands-search-input');if(!search)throw Error('SWANSON_DIRECTORY_TEMPLATE');
return {codec:'swanson-brand-directory/1',${common},title:document.querySelector('h1')?.innerText?.trim(),searchValue:search.value,
entries:[...document.querySelectorAll('.brand-item a')].map(a=>({name:a.innerText.trim(),url:a.href}))}; })()`;
// Variant routes omit rel=canonical, but expose the same exact product identity in
// og:url with og:type=product. Never fall back to location or manufacture a URL.
export const swansonCanonicalExpression = `(document.querySelector('link[rel="canonical"]')?.href||(document.querySelector('meta[property="og:type"]')?.content==='product'?document.querySelector('meta[property="og:url"]')?.content:undefined))`;
const canonical=swansonCanonicalExpression;
const product = `(() => { const headings=[...document.querySelectorAll('h1')];if(headings.length!==1)throw Error('SWANSON_PRODUCT_TEMPLATE');
return {${common},canonicalUrl:${canonical},title:headings[0].innerText.trim(),
selectedForms:[...document.querySelectorAll('product-form-component[data-product-id]')].map(f=>({productId:f.getAttribute('data-product-id'),variantIds:[...f.querySelectorAll('input[name="id"]')].map(i=>i.value)})),
gallery:[...document.querySelectorAll('slideshow-slide .product-media img')].map(i=>({url:i.currentSrc||i.src,alt:i.alt||''})),
variantPicker:{unmapped:[...document.querySelectorAll('input[role="radio"]')].filter(i=>!i.hasAttribute('data-connected-product-url')||!i.hasAttribute('data-variant-id')).length,
options:[...document.querySelectorAll('input[role="radio"][data-connected-product-url][data-variant-id]')].map(i=>({group:i.name,label:i.value,url:new URL(i.getAttribute('data-connected-product-url'),location.href).href,variantId:i.getAttribute('data-variant-id'),selected:i.checked,available:i.getAttribute('data-option-available')==='true'}))},
sections:[...document.querySelectorAll('details')].filter(d=>['Product Details','Product Facts'].includes(d.querySelector('summary')?.innerText.trim())).map(d=>({heading:d.querySelector('summary').innerText.trim(),text:d.innerText}))}; })()`;

/** Public DOM only: no scripts, window globals, credentials or whole-page HTML leave the browser. */
export class SwansonEgoReader {
  private readonly config: EgoBrowserConfig;
  constructor(config: EgoBrowserConfig, private readonly runner: EgoCommandRunner = new EgoCliRunner()) {
    this.config = EgoBrowserConfigSchema.parse(config);
  }
  private async read(url: string, kind: "directory" | "product" | "catalog", signal: AbortSignal) {
    if (kind === "directory" ? url !== SWANSON_BRANDS_URL : kind === "catalog" ? !swansonCatalogAddress(url) : !swansonProductAddress(url)) throw new ChannelError("CHANNEL.URL_REJECTED");
    const c = this.config, expression = kind === "directory" ? directory : kind === "catalog" ? swansonCatalogProjectionExpression : product;
    const reveal = `(() => {for(const d of document.querySelectorAll('details'))if(['Product Details','Product Facts'].includes(d.querySelector('summary')?.innerText.trim())&&!d.open)d.querySelector('summary').click();})()`;
    const ready=kind==="product"?`(()=>{const f=[...document.querySelectorAll('product-form-component[data-product-id]')];return !!${canonical}&&f.length===1&&f[0].querySelectorAll('input[name="id"]').length===1;})()`:null;
    const settle=(evaluate:string)=>ready?`let ready=false;for(let n=0;n<40;n++){if(await ${evaluate}(${JSON.stringify(ready)})){ready=true;break;}await new Promise(r=>setTimeout(r,200));}if(!ready)throw Error('SWANSON_PRODUCT_NOT_READY');`:"";
    const select = `const selected=tabs.filter(t=>t.targetId===${JSON.stringify(c.targetId)}${c.sdk === "2" ? "&&t.label" : ""});if(selected.length!==1)throw Error('EGO_TARGET_MISMATCH');`;
    const script = c.sdk === "1" ? `await useOrCreateTaskSpace(${c.taskSpaceId});const tabs=await listTabs();${select}
await switchTab(selected[0].targetId);if(selected[0].url!==${JSON.stringify(url)})await gotoAndWait(${JSON.stringify(url)},{timeout:20});
${settle("js")}
${kind === "product" ? `await js(${JSON.stringify(reveal)});` : ""}
const value=await js(${JSON.stringify(expression)});const snapshot={taskSpaceId:${c.taskSpaceId},targetId:selected[0].targetId,value};` :
      `const task=await taskSpace(${c.taskSpaceId});const tabs=await task.tabs();${select}const page=task.page(selected[0].label);
if(selected[0].url!==${JSON.stringify(url)})await page.goto(${JSON.stringify(url)},{timeout:20000});
${settle("page.evaluate")}
${kind === "product" ? `await page.evaluate(${JSON.stringify(reveal)});` : ""}
const value=await page.evaluate(${JSON.stringify(expression)});const snapshot={taskSpaceId:${c.taskSpaceId},targetId:selected[0].targetId,value};`;
    const output = z.strictObject({ taskSpaceId: z.literal(c.taskSpaceId), targetId: z.literal(c.targetId), value: z.unknown() })
      .parse(await this.runner.run(c.cliPath, script, signal));
    const result = kind === "directory" ? SwansonBrandDirectorySchema.parse(output.value) : kind === "catalog" ? SwansonCatalogProjectionSchema.parse(output.value) : SwansonRenderedProductSchema.parse(output.value);
    if (kind === "catalog" ? swansonCatalogAddress(result.url)!==swansonCatalogAddress(url)||new URL(result.url).searchParams.get("page")!==new URL(url).searchParams.get("page") : result.url!==url) throw new ChannelError("CHANNEL.IDENTITY_CONFLICT");
    return result;
  }
  async directory(signal: AbortSignal) { return SwansonBrandDirectorySchema.parse(await this.read(SWANSON_BRANDS_URL, "directory", signal)); }
  async product(url: string, signal: AbortSignal) { return SwansonRenderedProductSchema.parse(await this.read(url, "product", signal)); }
  async catalog(url:string,brandName:string,signal:AbortSignal){
    const projection=SwansonCatalogProjectionSchema.parse(await this.read(url,"catalog",signal));
    return{projection,catalog:parseSwansonRenderedCatalog(projection,swansonCatalogAddress(url),brandName)};
  }
}
