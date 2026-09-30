import { DtcSnapshotSchema,DtcDecisionSchema,DtcRenderedProductSchema,DtcRenderedCatalogSchema,type DtcSnapshot,type DtcSitePolicy } from "@crawl-automation/v3-contracts";
import {type CdpTaskPort,type CdpOwnedPage,permittedUrl}from"@crawl-automation/v3-acquisition";
import{dtcAddress,validateDtcSite}from"./dtc-rendered.js";
export interface DtcDecider{decide(snapshot:DtcSnapshot,mode:"catalog"|"product",signal:AbortSignal,progress?:{visitedControls:number[]}):Promise<unknown>}
export type DtcRetain=(step:number,snapshot:DtcSnapshot,decision:unknown,screenshot:Uint8Array,signal:AbortSignal)=>Promise<string>;
/** Codex selects evidence by indices; it cannot invent URLs/text, run JS or access credentials.
 * All navigation is bounded by the caller's explicit source; gallery controls are deployment allowlisted. */
export class DtcCdpReader{
 constructor(readonly page:CdpOwnedPage,readonly port:CdpTaskPort,readonly site:DtcSitePolicy,readonly decider:DtcDecider,readonly retain:DtcRetain){validateDtcSite(site);}
 private async js(expression:string,s:AbortSignal){const r=await this.port.call(this.page.targetId,"Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true},s);if(r.exceptionDetails||!r.result||r.result.subtype==="error")throw Error("DTC.BROWSER_READ_FAILED");return r.result.value;}
 private async dismissGallery(url:string,root:string,s:AbortSignal){
  const selectors=this.site.galleryDismissControls??[];if(!selectors.length)return;
  const query=`(()=>{if(location.href!==${JSON.stringify(url)})throw Error('DTC_URL_CHANGED');const root=document.querySelector(${JSON.stringify(root)});return [...root.querySelectorAll(${JSON.stringify(selectors.join(','))})].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility==='visible'});})()`;
  const position=await this.js(`(()=>{const nodes=${query};if(!nodes.length)return null;if(nodes.length!==1)throw Error('DTC_DISMISS_AMBIGUOUS');const e=nodes[0];if(e.closest('form')||e.closest('a[href]'))throw Error('DTC_DISMISS_UNSAFE');const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('DTC_DISMISS_OCCLUDED');return{x,y};})()`,s);
  if(!position)return;
  for(const type of ['mousePressed','mouseReleased'])await this.port.call(this.page.targetId,'Input.dispatchMouseEvent',{type,...position,button:'left',clickCount:1},s);
  for(let n=0;n<25;n++){if(await this.js(`(${query}).length===0`,s))return;await new Promise(r=>setTimeout(r,200));}
  throw Error('DTC.GALLERY_DISMISS_PENDING');
 }
 private expression(url:string,root:string){return `(()=>{if(location.href!==${JSON.stringify(url)})throw Error('DTC_URL_CHANGED');const roots=[...document.querySelectorAll(${JSON.stringify(root)})];if(roots.length!==1)throw Error('DTC_ROOT_AMBIGUOUS');const nodes=[...roots[0].querySelectorAll('h1,h2,h3,p,li,table,a,img,button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});if(nodes.length>1200)throw Error('DTC_PAGE_LIMIT');return {url:location.href,title:document.title,capturedAt:new Date().toISOString(),nodes:nodes.map((e,index)=>({index,tag:e.tagName.toLowerCase(),text:(e.innerText||e.alt||e.getAttribute?.('aria-label')||'').slice(0,6000),href:e.tagName==='A'&&/^https:\\//.test(e.href)?e.href:null,src:e.tagName==='IMG'&&e.complete&&/^https:\\//.test(e.currentSrc||e.src)?e.currentSrc||e.src:null,width:e.naturalWidth||0,height:e.naturalHeight||0,control:${JSON.stringify(this.site.galleryControls)}.some(q=>e.matches(q))&&!e.closest('form')&&!e.closest('a[href]')}))}})()`;}
 async read(rawUrl:string,mode:"catalog"|"product",signal:AbortSignal){const s=AbortSignal.any([signal,AbortSignal.timeout(mode==="catalog"?90000:240000)]);const url=dtcAddress(rawUrl).url;
  permittedUrl(url,[this.site.origin]);if(mode==="catalog"?!this.site.catalogPages.includes(url):!new URL(url).pathname.startsWith(this.site.productPathPrefix))throw Error("DTC.URL_SCOPE");
  const current=(await this.port.list(s)).find(t=>t.id===this.page.targetId);if(!current)throw Error("SOURCE.TARGET_MISSING");
  if(current.url!==url){if(!current.url.startsWith("about:blank#crawlv3-"))throw Error("DTC.PAGE_ALREADY_NAVIGATED");await this.port.call(this.page.targetId,"Page.navigate",{url},s);}
  const root=mode==="catalog"?this.site.catalogRoot:this.site.productRoot,expression=this.expression(url,root);
  let ready=false;for(let i=0;i<60;i++){s.throwIfAborted();if(await this.js(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'&&document.querySelectorAll(${JSON.stringify(root)}).length===1`,s)){ready=true;break;}await new Promise(r=>setTimeout(r,200));}if(!ready)throw Error("DTC.PAGE_NOT_READY");
  const keys:string[]=[],images=new Set<string>(),clicked=new Set<string>();let pendingImages=new Set<string>();
  const controlKey=(n:DtcSnapshot['nodes'][number])=>JSON.stringify([n.tag,n.text,n.href,n.src]);
  // Responsive resizing of the same asset is not a new gallery view.
  const imageKey=(src:string)=>{const u=new URL(src);return u.origin+u.pathname;};
  for(let step=0;step<this.site.maxDecisions;step++){
   const snapshot=DtcSnapshotSchema.parse(await this.js(expression,s));
   const shot=await this.port.call(this.page.targetId,"Page.captureScreenshot",{format:"png"},s),image=Buffer.from(shot.data,"base64");if(!image.length||image.length>4*1024*1024)throw Error("DTC.SCREENSHOT_INVALID");
   // Capture is retained before a model turn, including when the model fails or requests Review.
   keys.push(await this.retain(step,snapshot,null,image,s));
   let decision=DtcDecisionSchema.parse(await this.decider.decide(snapshot,mode,s,{visitedControls:snapshot.nodes.filter(n=>n.control&&clicked.has(controlKey(n))).map(n=>n.index)}));
   // A model's early capture is not evidence that the observed gallery is done.
   // Use the deployment-allowlisted controls only; never broaden to other buttons.
   const controls=mode==='product'&&decision.action!=='review'?snapshot.nodes.filter(n=>n.control):[];
   const unique=new Set(controls.map(controlKey));if(unique.size!==controls.length)throw Error('DTC.CONTROL_AMBIGUOUS');
   const pending=controls.find(n=>!clicked.has(controlKey(n)));
   if(decision.action==='capture'&&pending)decision={...decision,action:'click',control:pending.index};
   await this.retain(step,snapshot,decision,image,s);
   const node=(id:number)=>{const n=snapshot.nodes.find(n=>n.index===id);if(!n)throw Error("DTC.INVENTED_EVIDENCE");return n;};
   if(decision.action==="review")throw Error(decision.reason==="challenge"?"SOURCE.BROWSER_USER_CONTROL":"DTC.EVIDENCE_REVIEW");
   for(const id of decision.images){const n=node(id);if(!n.src||n.width<300||n.height<300)throw Error("DTC.IMAGE_UNVERIFIED");permittedUrl(n.src,this.site.imageOrigins);images.add(n.src);}
   if(pendingImages.size&&!decision.images.some(id=>{const src=node(id).src;return src&&pendingImages.has(imageKey(src));}))throw Error('DTC.GALLERY_IMAGE_MISSING');
   pendingImages=new Set();
   if(images.size>100)throw Error("DTC.IMAGE_LIMIT");
   if(decision.action==="click"){
    if(mode!=="product"||decision.control===null)throw Error("DTC.CONTROL_UNVERIFIED");const n=node(decision.control);if(!n.control||n.href||!['button','img'].includes(n.tag))throw Error("DTC.CONTROL_UNVERIFIED");
    const mark=controlKey(n);if(clicked.has(mark))throw Error("DTC.CONTROL_REPEAT");clicked.add(mark);
    await this.dismissGallery(url,root,s);
    const position=await this.js(`(()=>{const before=${expression};const expected=${JSON.stringify(n)};if(JSON.stringify(before.nodes[expected.index])!==JSON.stringify(expected))throw Error('STALE_NODE');const root=document.querySelector(${JSON.stringify(root)});const e=[...root.querySelectorAll('h1,h2,h3,p,li,table,a,img,button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0})[expected.index];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('DTC_CONTROL_OCCLUDED');return{x,y}})()`,s);
    for(const type of["mousePressed","mouseReleased"])await this.port.call(this.page.targetId,"Input.dispatchMouseEvent",{type,...position,button:"left",clickCount:1},s);
    // A thumbnail click must expose a new loaded large image before another
    // decision. A timer alone can silently carry the previous slide forward.
    const before=new Set(snapshot.nodes.filter(n=>n.src&&n.width>=300&&n.height>=300).map(n=>imageKey(n.src!)));
    let changed=false;
    for(let attempt=0;attempt<40;attempt++){
     s.throwIfAborted();const after=DtcSnapshotSchema.parse(await this.js(expression,s));
     pendingImages=new Set(after.nodes.filter(n=>n.src&&n.width>=300&&n.height>=300&&!before.has(imageKey(n.src))).map(n=>imageKey(n.src!)));
     if(pendingImages.size){changed=true;break;}
     await new Promise(r=>setTimeout(r,200));
    }
    if(!changed)throw Error('DTC.GALLERY_NOT_READY');
    continue;
   }
   if(mode==="catalog"){
    const navigation=snapshot.nodes.flatMap(n=>n.href&&this.site.catalogPages.includes(n.href)?[n.href]:[]);
    const entries=decision.links.map(id=>{const n=node(id);if(!n.href)throw Error("DTC.INVENTED_EVIDENCE");const a=dtcAddress(n.href);if(new URL(a.url).origin!==this.site.origin||!new URL(a.url).pathname.startsWith(this.site.productPathPrefix))throw Error("DTC.URL_SCOPE");return{...a,variantId:null,title:n.text.slice(0,4000)||null};});
    return DtcRenderedCatalogSchema.parse({codec:"dtc-catalog-rendered/1",url,brandName:this.site.brandName,entries:[...new Map(entries.map(e=>[e.listingId,e])).values()],navigation,snapshotKeys:keys});
   }
   if(decision.title===null)throw Error("DTC.TITLE_MISSING");const title=node(decision.title);if(!["h1","h2"].includes(title.tag)||!title.text.trim())throw Error("DTC.TITLE_UNVERIFIED");
   return DtcRenderedProductSchema.parse({codec:"dtc-rendered/1",...dtcAddress(url),brandName:this.site.brandName,title:title.text.trim(),sections:decision.sections.map(id=>node(id).text).filter(Boolean),images:[...images],selectedOnly:true,snapshotKeys:keys});
  }
  throw Error("DTC.DECISION_LIMIT");
 }
}
