import { describe, it, expect } from "vitest";
import { holdRequest, gncMouseInteraction, nativeReceiptComplete, holdNodes } from "./gnc-mouse-challenge.js";
const target = () => ({ url:"https://www.gnc.com/energy/613701.html", title:"Access to this page has been denied",
  hits:[{x:400,y:300,width:200,height:60}], metrics:{screenX:22,screenY:52,outerWidth:1200,outerHeight:800,innerWidth:1200,innerHeight:700,scale:1} });
const window = () => ({pid:123,windowId:4,title:"Access to this page has been denied",bounds:[22,52,1200,800]});
describe("GNC native mouse target boundary", () => {
  it("finds exact button labels through frame and shadow DOM, not bare text",()=>{
    const button={nodeId:4,nodeName:"DIV",attributes:["role","button","aria-label","Press & Hold"]};
    expect(holdNodes({nodeName:"#document",children:[{nodeName:"IFRAME",contentDocument:{nodeName:"#document",shadowRoots:[button]}}]})).toEqual([button]);
    expect(holdNodes({nodeName:"DIV",children:[{nodeType:3,nodeValue:"Press & Hold"}]})).toEqual([]);
    expect(holdNodes({nodeId:5,nodeName:"DIV",attributes:["role","button","aria-label","按住"]})).toHaveLength(1);
    expect(holdNodes({nodeId:5,nodeName:"DIV",attributes:["role","button","aria-label","按住并购买"]})).toHaveLength(0);
  });
  it("requires the app's complete receipt, not launch or partial DOWN output",()=>{
    expect(nativeReceiptComplete("hold",[])).toBe(false);
    expect(nativeReceiptComplete("hold",[{event:"DOWN_POSTED"}])).toBe(false);
    expect(nativeReceiptComplete("hold",[{event:"DOWN_POSTED"},{event:"UP_POSTED"}])).toBe(true);
    expect(nativeReceiptComplete("inspect",[{accessibility:true,postEventAccess:true,screenRecording:true,windows:[]}])).toBe(true);
    expect(nativeReceiptComplete("inspect",[{accessibility:true}])).toBe(false);
  });
  it("converts fresh viewport CSS coordinates to native window ratios", () => {
    expect(holdRequest(target(),window(),123)).toMatchObject({xRatio:500/1200,yRatio:430/800,holdMs:10000,pid:123,windowId:4});
  });
  it("passes three distinct in-viewport waypoints to the existing native tool",()=>{
    const r=holdRequest(target(),window(),123);
    expect(r.movePath).toHaveLength(3);
    expect(new Set(r.movePath.map(p=>p.join(","))).size).toBe(3);
    for(const [x,y] of r.movePath) {expect(x).toBeGreaterThanOrEqual(.05);expect(x).toBeLessThanOrEqual(.95);expect(y).toBeGreaterThanOrEqual(.15);expect(y).toBeLessThanOrEqual(.9);}
    expect(r.movePath.at(-1)).not.toEqual([r.xRatio,r.yRatio]);
  });
  it("adapts waypoints near the viewport edge instead of reusing old screen coordinates",()=>{
    const s=target();s.hits[0]!.x=0;
    const r=holdRequest(s,window(),123);
    expect(r.movePath[0]![0]).toBe(.05);
    expect(r.movePath.every(p=>p[0]!>0&&p[1]!>0)).toBe(true);
  });
  it.each(["empty","ambiguous","other-sku","other-title","zoom","moved","offscreen","huge","nan"])("does not guess %s targets", variant => {
    const s=target();
    if(variant==="empty")s.hits=[];
    if(variant==="ambiguous")s.hits.push({...s.hits[0]!});
    if(variant==="other-sku")s.url="https://www.gnc.com/energy/123456.html";
    if(variant==="other-title")s.title="Product";
    if(variant==="zoom")s.metrics.scale=2;
    if(variant==="moved")s.metrics.screenX+=20;
    if(variant==="offscreen")s.hits[0]!.x=-10;
    if(variant==="huge")s.hits[0]!.height=1000;
    if(variant==="nan")s.hits[0]!.x=NaN;
    expect(()=>holdRequest(s,window(),123)).toThrow(/GNC.MOUSE_/);
  });
  it("rejects another process",()=>expect(()=>holdRequest(target(),window(),124)).toThrow("GNC.MOUSE_TARGET_MISMATCH"));
  it("ordinary products and other URLs do not touch any mouse/evidence dependency",async()=>{
    const task:any={capture:{kind:"product",url:target().url}};
    const fn=gncMouseInteraction(task,{browserPid:1,profilePath:"/unused"},{} as any);
    await fn({url:target().url,html:"<title>Product</title>"} as any,{} as any,new AbortController().signal);
    await fn({url:"https://www.gnc.com/other.html",html:`<title>${target().title}</title>`} as any,{} as any,new AbortController().signal);
  });
});
