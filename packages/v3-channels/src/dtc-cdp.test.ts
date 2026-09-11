import{it,expect,vi}from'vitest';import{runInNewContext}from'node:vm';import{DtcCdpReader}from'./dtc-cdp.js';import{DtcSitePolicySchema}from'@crawl-automation/v3-contracts';
const url='https://brand.example/products/one';
function fixture(){const site=DtcSitePolicySchema.parse({origin:'https://brand.example',brandName:'Example',catalogPages:['https://brand.example/collections/all'],productPathPrefix:'/products/',catalogRoot:'main',productRoot:'main',imageOrigins:['https://brand.example'],galleryControls:['button.gallery'],maxDecisions:2,selectedUrls:null});
 const node=(index:number,tag:string,text:string,extra={})=>({index,tag,text,href:null,src:null,width:0,height:0,control:false,...extra});
 const snapshot={url,title:'One',capturedAt:'2026-09-11T00:00:00.000Z',nodes:[node(0,'h1','One'),node(1,'p','Ingredients'),node(2,'img','Label',{src:'https://brand.example/label.jpg',width:800,height:900}),node(3,'button','Buy')]};
 const decision={action:'capture',title:0,sections:[1],links:[],images:[2],control:null,reason:'none'};
 const port={guard:vi.fn(),list:vi.fn(async()=>[{id:'owned',type:'page',url}]),create:vi.fn(),close:vi.fn(),call:vi.fn(async(_id:string,method:string,params:any)=>method==='Page.captureScreenshot'?{data:Buffer.from('png-fixture').toString('base64')}:method==='Runtime.evaluate'?{result:{value:params.expression.startsWith('location.href')?true:snapshot}}:{})};
 const decider={decide:vi.fn(async()=>decision)},retain=vi.fn(async()=> 'v3/snapshot.json');
 const reader=new DtcCdpReader({taskId:'test',targetId:'owned',config:{endpoint:'http://127.0.0.1:9222/',instanceId:'id',pauseFile:'/pause'}},port,site,decider,retain);return{reader,port,site,snapshot,decision,decider,retain};}
it('saves screenshot and DOM before Codex; selected evidence is observed original URL/text',async()=>{const f=fixture();f.decider.decide.mockImplementation(async()=>{expect(f.retain).toHaveBeenCalledOnce();return f.decision;});expect(await f.reader.read(url,'product',AbortSignal.timeout(1000))).toMatchObject({title:'One',images:['https://brand.example/label.jpg'],selectedOnly:true});expect(f.port.call.mock.calls.some(c=>c[1]==='Page.navigate')).toBe(false);});
it.each(['invented','small','foreign','buy'])('rejects unsafe/unobserved %s choice',async mode=>{const f=fixture();if(mode==='invented')f.decision.images=[999];if(mode==='small')f.snapshot.nodes[2]!.width=100;if(mode==='foreign')f.snapshot.nodes[2]!.src='https://evil.example/a.jpg';if(mode==='buy'){f.decision.action='click';f.decision.control=3 as any;}await expect(f.reader.read(url,'product',AbortSignal.timeout(1000))).rejects.toThrow();expect(f.port.call.mock.calls.some(c=>c[1]==='Input.dispatchMouseEvent')).toBe(false);});
it('challenge requests user control after retaining evidence',async()=>{const f=fixture();f.decision.action='review';f.decision.reason='challenge';await expect(f.reader.read(url,'product',AbortSignal.timeout(1000))).rejects.toThrow('USER_CONTROL');expect(f.retain).toHaveBeenCalledTimes(2);});
it('actual generated snapshot JS compiles and selects only HTTPS public links/images',async()=>{const f=fixture();await f.reader.read(url,'product',AbortSignal.timeout(1000));const expression=f.port.call.mock.calls.find(c=>c[1]==='Runtime.evaluate'&&c[2].expression.startsWith('(()=>'))![2].expression;
 const e={tagName:'IMG',alt:'Label',complete:true,currentSrc:'https://brand.example/label.jpg',naturalWidth:800,naturalHeight:900,getBoundingClientRect:()=>({width:50,height:50}),matches:()=>false,closest:()=>null};
 const result=runInNewContext(expression,{location:{href:url},document:{title:'One',querySelectorAll:()=>[{querySelectorAll:()=>[e]}]}});expect(result.nodes[0].src).toBe(e.currentSrc);});

function galleryFixture(){
 const f=fixture();f.site.maxDecisions=4;
 const node=(index:number,tag:string,text:string,extra={})=>({index,tag,text,href:null,src:null,width:0,height:0,control:false,...extra});
 f.snapshot.nodes[2]!.src='https://brand.example/front.jpg';
 f.snapshot.nodes.push(node(4,'button','Load image 2 in gallery view',{control:true}),node(5,'img','Label thumbnail',{src:'https://brand.example/label-small.jpg',width:86,height:86}),node(7,'button','Load image 3 in gallery view',{control:true}),node(8,'img','Back thumbnail',{src:'https://brand.example/back-small.jpg',width:86,height:86}));
 const sources=['https://brand.example/front.jpg','https://brand.example/label.jpg','https://brand.example/back.jpg'];let slide=0,settleReads=0;
 f.port.call.mockImplementation(async(_id,method,params)=>{
  if(method==='Page.captureScreenshot')return{data:Buffer.from('png-fixture').toString('base64')};
  if(method==='Input.dispatchMouseEvent'){if(params.type==='mouseReleased'){slide++;settleReads=0;}return{};}
  if(method==='Runtime.evaluate'){
   if(params.expression.startsWith('location.href'))return{result:{value:true}};
   if(params.expression.includes('scrollIntoView'))return{result:{value:{x:10,y:20}}};
   const snapshot=structuredClone(f.snapshot);snapshot.nodes[2]!.src=sources[slide]!;
   // Simulate a lazy-loaded gallery image. The thumbnail itself stays 86px.
   if(slide&&settleReads++===0){snapshot.nodes[2]!.width=0;snapshot.nodes[2]!.height=0;}
   return{result:{value:snapshot}};
  }
  return{};
 });return f;
}
it('an early capture must traverse both observed thumbnails and wait for loaded large images',async()=>{
 const f=galleryFixture();
 const result=await f.reader.read(url,'product',AbortSignal.timeout(5000));
 expect(result).toMatchObject({images:['https://brand.example/front.jpg','https://brand.example/label.jpg','https://brand.example/back.jpg']});
 expect(f.decider.decide).toHaveBeenCalledTimes(3);
 const decisions=f.retain.mock.calls.map(c=>c[2]).filter(Boolean);
 expect(decisions).toMatchObject([{action:'click',control:4},{action:'click',control:7},{action:'capture'}]);
 expect(f.port.call.mock.calls.filter(c=>c[1]==='Input.dispatchMouseEvent'&&c[2].type==='mouseReleased')).toHaveLength(2);
});
it('a gallery that cannot finish within the configured bound cannot publish a partial capture',async()=>{
 const f=galleryFixture();f.site.maxDecisions=2;
 await expect(f.reader.read(url,'product',AbortSignal.timeout(5000))).rejects.toThrow('DTC.DECISION_LIMIT');
});
it('a challenge still stops before automatic gallery traversal',async()=>{
 const f=galleryFixture();f.decision.action='review';f.decision.reason='challenge';
 await expect(f.reader.read(url,'product',AbortSignal.timeout(1000))).rejects.toThrow('USER_CONTROL');
 expect(f.port.call.mock.calls.some(c=>c[1]==='Input.dispatchMouseEvent')).toBe(false);
});
it('indistinguishable gallery controls stop instead of guessing which slide was visited',async()=>{
 const f=galleryFixture();f.snapshot.nodes.find(n=>n.index===7)!.text=f.snapshot.nodes.find(n=>n.index===4)!.text;
 await expect(f.reader.read(url,'product',AbortSignal.timeout(1000))).rejects.toThrow('CONTROL_AMBIGUOUS');
 expect(f.port.call.mock.calls.some(c=>c[1]==='Input.dispatchMouseEvent')).toBe(false);
});
it('a loaded gallery image cannot be omitted from the next selection',async()=>{
 const f=galleryFixture();let decisions=0;
 f.decider.decide.mockImplementation(async()=>({...f.decision,images:decisions++===0?[2]:[]}));
 await expect(f.reader.read(url,'product',AbortSignal.timeout(5000))).rejects.toThrow('DTC.GALLERY_IMAGE_MISSING');
});
it('visited controls are supplied to each decision and survive index-independent identity',async()=>{
 const f=galleryFixture();await f.reader.read(url,'product',AbortSignal.timeout(5000));
 expect((f.decider.decide.mock.calls as unknown[][]).map(c=>c[3])).toEqual([{visitedControls:[]},{visitedControls:[4]},{visitedControls:[4,7]}]);
});
it('challenge wins over ambiguous controls and never dismisses a preview',async()=>{
 const f=galleryFixture();f.decision.action='review';f.decision.reason='challenge';f.site.galleryDismissControls=['.close'];
 f.snapshot.nodes.find(n=>n.index===7)!.text=f.snapshot.nodes.find(n=>n.index===4)!.text;
 await expect(f.reader.read(url,'product',AbortSignal.timeout(1000))).rejects.toThrow('USER_CONTROL');
 expect(f.port.call.mock.calls.some(c=>c[1]==='Input.dispatchMouseEvent')).toBe(false);
});
it('dismisses an allowlisted preview before opening the next thumbnail',async()=>{
 const f=galleryFixture();f.site.galleryDismissControls=['.close'];const base=f.port.call.getMockImplementation()!;
 let clicks=0,dismissed=0;
 f.port.call.mockImplementation(async(id,method,params)=>{
  if(method==='Runtime.evaluate'&&params.expression.includes('DTC_DISMISS_AMBIGUOUS'))return{result:{value:clicks?{x:90,y:10}:null}};
  if(method==='Runtime.evaluate'&&params.expression.endsWith('.length===0'))return{result:{value:true}};
  if(method==='Input.dispatchMouseEvent'&&params.x===90){if(params.type==='mouseReleased')dismissed++;return{};}
  if(method==='Input.dispatchMouseEvent'&&params.type==='mouseReleased')clicks++;
  return base(id,method,params);
 });
 expect((await f.reader.read(url,'product',AbortSignal.timeout(5000))).images).toHaveLength(3);
 expect(dismissed).toBe(1);
});
