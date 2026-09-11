import {readFileSync} from "node:fs";
import {join} from "node:path";
import {expect,it} from "vitest";
import {extractSwansonLabelCore,PrepareSwansonLabelCore} from "./swanson-label-core.js";
import {parseSwansonRenderedProduct} from "../../v3-channels/src/swanson-rendered.js";
import {fixture as textFixture} from "../../v3-text/src/testing.fixture.js";
import {sha256} from "@crawl-automation/v3-artifacts";
const escape=(s:string)=>`<pre>${s.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</pre>`;
const text="Supplement Facts\nServing Size 1 Softgel\nAmount Per Serving\nBlend\n125 mg\nOther Ingredients: Gelatin, water.\n\nSuggested Use: one daily\nWarning: consult doctor";
it.each(["swanson-product-public.json","swanson-second-public.json"])("isolates actual label without rewriting %s",name=>{
 const root=process.env.V3_CHANNEL_FIXTURE_ROOT;if(!root)throw Error("Fixture root required");
 const p=JSON.parse(readFileSync(join(root,name),"utf8")),form=p.selectedForms[0],product=parseSwansonRenderedProduct(p,p.url,{listingId:form.productId,variantId:form.variantIds[0]});
 const core=extractSwansonLabelCore(product.factsCandidates[0]!.html+"\n"+product.detailsHtml);
 expect(core).toContain("Other Ingredients: BSE-free gelatin (capsule), vegetable glycerine, double-distilled and deionized water.");
 expect(core).not.toMatch(/Suggested Use|Warning:|Storage Instructions|Maximum Health/);
 expect(core).toContain(name.includes("second")?"268 mg":"125 mg");
});
it.each(["duplicate","nested","no-boundary","empty","script"])("rejects ambiguous %s",mode=>{
 let html=escape(text);
 if(mode==="duplicate")html+=html;
 if(mode==="nested")html=html.replace("Blend","<b>Blend</b>");
 if(mode==="no-boundary")html=escape(text.split("Suggested Use")[0]!);
 if(mode==="empty")html=escape(text.replace("Gelatin, water.",""));
 if(mode==="script")html+="<script>ignored?</script>";
 expect(()=>extractSwansonLabelCore(html)).toThrow();
});
it("retains original provenance and cold inspect verifies without a new publication",async()=>{
 const f=textFixture(),html=Buffer.from(escape(text));
 const source={...f.source,sha256:sha256(html),byteSize:html.length,producer:{...f.source.producer,module:"channel.product-input",implementationVersion:"channel-plan/1"}};
 const full={...f.document,source},bytes=Buffer.from(JSON.stringify(full)),ref={...f.ref,sha256:sha256(bytes),byteSize:bytes.length};
 const resolver={resolve:async(r:any)=>({bytes:r.objectKey===source.objectKey?html:bytes,ref:r,from:"remote" as const,cacheRetained:false})};
 const core=new PrepareSwansonLabelCore(resolver,f.remote),input={owner:f.owner,fullDocument:ref};
 const result=await core.run(input,AbortSignal.timeout(1000));expect(result.document.producer.implementationVersion).toBe("swanson-label-core/1");
 expect(await core.inspect(input,AbortSignal.timeout(1000))).toEqual(result);
 const stored=JSON.parse(Buffer.from(f.remote.data.get(result.document.objectKey)!).toString());expect(stored.source).toEqual(source);expect(stored.text).toContain("125 mg");
});
