import{AmazonRenderedProductSchema,AmazonRenderedCatalogSchema,ChannelProductEvidenceSchema,type Observation}from'@crawl-automation/v3-contracts';
import{ChannelError,channelUrl}from'./html-evidence.js';
export function amazonProductAddress(raw:string){const u=channelUrl(raw,'amazon'),asin=u.pathname.match(/^\/(?:-\/[a-z]{2}\/)?(?:(?:[^/]+\/)?dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/)?.[1];if(!asin)throw new ChannelError('AMAZON.ASIN_CONFLICT');return{asin,url:`${u.origin}/dp/${asin}`};}
export function amazonStoreAddress(raw:string){const u=channelUrl(raw,'amazon'),id=u.pathname.match(/^\/(?:-\/[a-z]{2}\/)?stores\/(?:[^/]+\/)?page\/([A-F0-9-]{36})\/?$/i)?.[1];if(!id)throw new ChannelError('AMAZON.STORE_REQUIRED');return{id:id.toUpperCase(),url:`${u.origin}/stores/page/${id.toUpperCase()}`};}
const esc=(s:string)=>'<pre>'+s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')+'</pre>';
export function parseAmazonRenderedProduct(raw:unknown,expectedUrl:string,owner:Pick<Observation,'listingId'|'variantId'>){
 const p=AmazonRenderedProductSchema.parse(raw);const canonical=channelUrl(p.canonicalUrl,'amazon');const canonicalAsin=canonical.pathname.match(/^\/(?:-\/[a-z]{2}\/)?clp\/([A-Z0-9]{10})$/)?.[1]??amazonProductAddress(p.canonicalUrl).asin;if(canonicalAsin!==p.asin||[p.url,expectedUrl].some(u=>amazonProductAddress(u).asin!==p.asin)||owner.listingId!==p.asin||owner.variantId!==null)throw new ChannelError('AMAZON.ASIN_CONFLICT');amazonStoreAddress(p.storeUrl);
 if(p.galleryCount!==p.gallery.length||new Set(p.gallery.map(i=>i.index)).size!==p.galleryCount||p.gallery.some(i=>i.index>=p.galleryCount))throw new ChannelError('AMAZON.GALLERY_UNVERIFIED');
 const images=p.gallery.map(i=>{const u=new URL(i.url);if(u.protocol!=='https:'||u.hostname!=='m.media-amazon.com'||u.port||u.username||u.password||u.hash||u.search||!u.pathname.startsWith('/images/I/'))throw new ChannelError('CHANNEL.IMAGE_URL_REJECTED');return i.url;});
 if(new Set(p.sections.map(s=>s.id)).size!==p.sections.length)throw new ChannelError('AMAZON.PRODUCT_UNVERIFIED');
 const variants=p.variants.map(v=>{if(amazonProductAddress(v.url).asin!==v.asin)throw new ChannelError('AMAZON.ASIN_CONFLICT');return{listingId:v.asin,variantId:null,url:v.url,title:v.label||null};});
 const facts=p.sections.find(s=>s.id==='important-information');
 return ChannelProductEvidenceSchema.parse({codec:'channel-product/1',channel:'amazon',listingId:p.asin,variantId:null,url:p.url,title:p.title,brandRaw:p.brandRaw,variantOptions:[],variants,
 detailsHtml:p.sections.filter(s=>s.id!=='important-information').map(s=>esc(s.text)).join('\n')||null,factsCandidates:facts?[{field:facts.id,html:esc(facts.text),scope:'selected-product'}]:[],
 imageCandidates:[...new Set(images)].map(url=>({url,variantId:null,basis:'selected-gallery',verifiedOriginal:false})),warnings:['CHANNEL.DOM_TEXT_PROJECTION','AMAZON.DELIVERY_CONTEXT_RETAINED',p.variantControls?'AMAZON.VARIANT_ENUMERATION_UNVERIFIED':'AMAZON.SELECTED_ASIN_ONLY']});
}
export function parseAmazonRenderedCatalog(raw:unknown,expectedUrl:string,storeName:string){const p=AmazonRenderedCatalogSchema.parse(raw);if(amazonStoreAddress(p.url).id!==amazonStoreAddress(expectedUrl).id||p.storeName.trim().toLowerCase()!==storeName.trim().toLowerCase())throw new ChannelError('AMAZON.STORE_IDENTITY_CONFLICT');
 const entries=new Map<string,{listingId:string;variantId:null;url:string;kind:'product'}>();
 for(const card of p.cards){if(card.sponsored)continue;const links=card.links.map(amazonProductAddress),ids=new Set(links.map(l=>l.asin));if(ids.size!==1)throw new ChannelError('AMAZON.ASIN_CONFLICT');const a=links[0]!;entries.set(a.asin,{listingId:a.asin,variantId:null,url:a.url,kind:'product'});}
 if(!entries.size)throw new ChannelError('AMAZON.CATALOG_UNVERIFIED');
 return{entries:[...entries.values()],navigation:p.navigation.map(n=>({...n,url:amazonStoreAddress(n.url).url})),completion:'unknown' as const};
}
