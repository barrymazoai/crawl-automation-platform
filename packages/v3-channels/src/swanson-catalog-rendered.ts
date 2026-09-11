import { z } from "zod";
import { ChannelError } from "./html-evidence.js";
import { normalizedBrandName,swansonBrandUrl } from "./channel-brand.js";
import { swansonProductAddress } from "./swanson-rendered.js";

export const swansonCatalogProjectionExpression=`(()=>{const root=document.querySelector('#ResultsList'),nav=document.querySelector('nav[aria-label="Product Listing Page pagination"]');return {evidenceVersion:2,url:location.href,capturedAt:new Date().toISOString(),title:document.querySelector('h1')?.innerText,
  pagination:nav?{currentPage:Number(nav.querySelector('[aria-current="page"]')?.getAttribute('data-page')),nextDisabled:nav.querySelector('a[aria-label="Go to next page"]')?.getAttribute('aria-disabled')==='true'}:null,
  headingContext:document.querySelector('h1')?.parentElement?.innerText?.slice(0,2000),
  results:root?{tag:root.tagName,text:root.innerText,links:[...root.querySelectorAll('a[href]')].map(a=>({text:a.innerText,url:a.href,ariaLabel:a.getAttribute('aria-label')})),
    children:[...root.children].slice(0,12).map(e=>({tag:e.tagName,class:e.className,id:e.id,role:e.getAttribute('role')}))}:null,
  visibleControls:[...document.querySelectorAll('button,nav a')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height)
    .map(e=>({tag:e.tagName,text:e.innerText,ariaLabel:e.getAttribute('aria-label'),disabled:e.getAttribute('aria-disabled')==='true'?true:e.disabled??null})).slice(0,100),
  nextLinks:[...document.querySelectorAll('a[rel="next"],nav a[aria-label="Go to next page"]')]
    .filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height&&e.getAttribute('aria-disabled')!=='true').map(e=>e.href)};})()`;

export const SwansonCatalogProjectionSchema=z.strictObject({url:z.string().url(),capturedAt:z.string().datetime(),title:z.string().min(1).max(1000),
  evidenceVersion:z.literal(2).optional(),pagination:z.strictObject({currentPage:z.number().int().positive(),nextDisabled:z.boolean()}).nullable().optional(),
  headingContext:z.string().max(2000).optional(),results:z.strictObject({tag:z.literal("UL"),text:z.string().max(100000),
    links:z.array(z.strictObject({text:z.string().max(4000),url:z.string().url(),ariaLabel:z.string().max(4000).nullable()})).max(200),
    children:z.array(z.strictObject({tag:z.string(),class:z.string(),id:z.string(),role:z.string().nullable()})).max(12)}).nullable(),
  visibleControls:z.array(z.strictObject({tag:z.string(),text:z.string().max(4000),ariaLabel:z.string().max(4000).nullable(),disabled:z.boolean().nullable()})).max(100),
  nextLinks:z.array(z.string().url().max(4096)).max(4).optional()});

/** Accept only the observed listing-view redirect, never arbitrary filters/other brands. */
export function swansonCatalogAddress(raw:string){
  const u=new URL(raw),view=u.searchParams.getAll("view"),page=u.searchParams.getAll("page");
  if(u.username||u.password||u.port||[...u.searchParams.keys()].some(k=>!["view","page"].includes(k))||view.length>1||page.length>1||page.length===1&&!/^[1-9][0-9]{0,4}$/.test(page[0]!)||
    view.length===1&&!/^sl-\d+$/.test(view[0]!)||u.hash&&!/^#slr-[a-z0-9]+$/.test(u.hash))throw new ChannelError("SWANSON.CATALOG_SCOPE_CONFLICT");
  return swansonBrandUrl(`${u.origin}${u.pathname}`);
}
/** URLs are discovery candidates, not product/variant identities. Those come from the selected detail form. */
export function parseSwansonRenderedCatalog(raw:unknown,brandUrl:string,brandName:string){
  const p=SwansonCatalogProjectionSchema.parse(raw),expected=swansonBrandUrl(brandUrl);
  if(swansonCatalogAddress(p.url)!==expected||normalizedBrandName(p.title)!==normalizedBrandName(brandName))throw new ChannelError("SWANSON.CATALOG_SCOPE_CONFLICT");
  if(!p.results)throw new ChannelError("SWANSON.CATALOG_NOT_READY");
  if(p.results.children.some(c=>c.tag!=="LI"||!c.class.split(/\s+/).includes("product-grid__item")))throw new ChannelError("SWANSON.CATALOG_TEMPLATE_UNVERIFIED");
  const entries=new Map<string,{url:string;handle:string;title:string}>(),primary=new Set<string>();
  for(const link of p.results.links){
    const address=swansonProductAddress(link.url),u=new URL(link.url);
    if(u.search||u.hash||!u.pathname.startsWith(`${new URL(expected).pathname}/p/`))throw new ChannelError("SWANSON.CATALOG_PRODUCT_CONFLICT");
    const title=(link.ariaLabel?.replace(/ - View Product$/," ").trim()||link.text.trim());
    if(!title)throw new ChannelError("SWANSON.CATALOG_TITLE_MISSING");
    // Sold-out cards also have a "See other options" link to the same product.
    // It is navigation text, not a contradictory product title.
    const isPrimary=Boolean(link.ariaLabel?.endsWith(" - View Product"));
    const old=entries.get(link.url);
    if(old){if(isPrimary&&primary.has(link.url)&&old.title!==title)throw new ChannelError("SWANSON.CATALOG_PRODUCT_CONFLICT");if(!isPrimary||primary.has(link.url))continue;}
    if(isPrimary)primary.add(link.url);
    entries.set(link.url,{url:link.url,handle:address.handle,title});
  }
  const countText=p.headingContext?.replace(p.title,"").trim(),match=countText?.match(/^(\d+) results?$/i),reportedTotal=match?Number(match[1]):null;
  const more=p.visibleControls.some(c=>c.disabled!==true&&/^(?:(?:go to )?next(?: page)?|load more|show more)$/i.test((c.ariaLabel||c.text).trim()));
  const links=[...new Set(p.nextLinks??[])];
  if(links.length>1)throw new ChannelError("SWANSON.PAGINATION_CONFLICT");
  const nextUrl=links[0]??null;
  if(nextUrl){const next=new URL(nextUrl),current=new URL(p.url);
    if(swansonCatalogAddress(nextUrl)!==expected||next.hash||Number(next.searchParams.get("page"))!==Number(current.searchParams.get("page")??1)+1)
      throw new ChannelError("SWANSON.PAGINATION_CONFLICT");}
  // Count refers only to this brand's displayed product families, not all selectable variants.
  const complete=reportedTotal!==null&&reportedTotal===entries.size&&!more&&!nextUrl;
  const listingEndVerified=reportedTotal!==null&&!more&&!nextUrl&&(complete||p.pagination?.nextDisabled===true&&p.pagination.currentPage===Number(new URL(p.url).searchParams.get("page")??1));
  return{codec:"swanson-rendered-catalog/1" as const,brandUrl:expected,observedUrl:p.url,capturedAt:p.capturedAt,brandName:p.title,entries:[...entries.values()],reportedTotal,nextUrl,listingEndVerified,
    completion:complete?"displayed_listing_complete" as const:"unverified_end" as const,variantCoverage:"unverified" as const,
    warnings:["SWANSON.VARIANT_ENUMERATION_UNVERIFIED",...(!complete?["SWANSON.CATALOG_END_UNVERIFIED"]:[])]};
}
