import { parseDocument } from "htmlparser2";
import { isDeepStrictEqual as equal } from "node:util";
import { ArtifactRefSchema, TextDocumentSchema, LabelCoreInputSchema, LabelCoreOutcomeSchema, observationIdentity } from "@crawl-automation/v3-contracts";
import { sha256, type ArtifactResolver, type ObjectStore } from "@crawl-automation/v3-artifacts";
/** Only the escaped public-DOM <pre> projection emitted by channel-plan/1.
 * Not a generic page cleaner; preserve ingredient words, values and grouping. */
export function extractSwansonLabelCore(html:string){
  if(Buffer.byteLength(html)>2*1024*1024)throw Error("LABEL_CORE.SOURCE_LIMIT");
  const root=parseDocument(html),sections:string[]=[];
  for(const node of root.children){
    if(node.type==="text"&&!node.data.trim())continue;
    if(node.type!=="tag"||node.name!=="pre"||node.children.some(n=>n.type!=="text"))throw Error("LABEL_CORE.SOURCE_UNSUPPORTED");
    sections.push(node.children.map(n=>n.type==="text"?n.data:"").join("").replace(/\r\n?/g,"\n").trim());
  }
  if(sections.length<1||sections.length>2)throw Error("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  const candidates=sections.filter(s=>/^(?:Supplement|Nutrition) Facts\s*\n/i.test(s));
  if(candidates.length!==1)throw Error("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  const facts=candidates[0]!,headings=[...facts.matchAll(/^Other Ingredients[ \t]*:/gim)];
  if(headings.length!==1||!/^Serving Size\b/im.test(facts)||!/^Amount Per Serving\b/im.test(facts))throw Error("LABEL_CORE.TABLE_UNVERIFIED");
  const start=headings[0]!.index!,after=start+headings[0]![0].length;
  const tail=facts.slice(after),boundary=/^\s*(?:Suggested Use|Directions|Warning|Warnings|Storage Instructions|Other Information)\s*:/im.exec(tail);
  if(!boundary)throw Error("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  const ingredients=tail.slice(0,boundary.index).trim();
  if(!ingredients||ingredients.includes("\n\n")||/^(?:Supplement|Nutrition) Facts\b/im.test(ingredients))throw Error("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  const text=facts.slice(0,after+boundary.index).replace(/[\t \u00a0]+/g," ").replace(/ *\n */g,"\n").replace(/\n{3,}/g,"\n\n").trim();
  if(text.length>200000)throw Error("LABEL_CORE.OUTPUT_LIMIT");return text;
}
export class PrepareSwansonLabelCore {
  constructor(private readonly artifacts:Pick<ArtifactResolver,"resolve">,private readonly remote:ObjectStore){}
  run(raw:unknown,signal:AbortSignal){return this.prepare(raw,signal,true)}
  inspect(raw:unknown,signal:AbortSignal){return this.prepare(raw,signal,false)}
  private async prepare(raw:unknown,signal:AbortSignal,publish:boolean){
    const input=LabelCoreInputSchema.parse(raw),full=TextDocumentSchema.parse(JSON.parse(Buffer.from((await this.artifacts.resolve(input.fullDocument,input.owner,signal)).bytes).toString()));
    if(full.producer!=="page.prepare"||!equal(observationIdentity(full),input.owner)||full.source.kind!=="source-html"||full.source.producer.module!=="channel.product-input"||full.source.producer.implementationVersion!=="channel-plan/1")throw Error("LABEL_CORE.IDENTITY_CONFLICT");
    const html=new TextDecoder("utf-8",{fatal:true}).decode((await this.artifacts.resolve(full.source,input.owner,signal)).bytes);
    const document=TextDocumentSchema.parse({...input.owner,producer:"label.core.prepare",source:full.source,corePolicy:"swanson-label-core/1",pageIndex:null,text:extractSwansonLabelCore(html)});
    const bytes=Buffer.from(JSON.stringify(document)),operationId=`core-${sha256(Buffer.from(JSON.stringify([input.owner,full.source,document.corePolicy])))}`;
    const ref=ArtifactRefSchema.parse({...full.source,kind:"result-json",mediaType:"application/json",artifactId:operationId,objectKey:`v3/label-core/${operationId}/document.json`,sha256:sha256(bytes),byteSize:bytes.length,producer:{operationId,module:"label.core.prepare",implementationVersion:"swanson-label-core/1"}});
    let saved=await this.remote.read(ref.objectKey,1048576,signal);
    if(!saved&&publish){try{await this.remote.create(ref.objectKey,bytes,"application/json",signal)}catch{}saved=await this.remote.read(ref.objectKey,1048576,signal)}
    if(!saved||sha256(saved)!==ref.sha256)throw Error("LABEL_CORE.HANDOFF_UNVERIFIED");
    return LabelCoreOutcomeSchema.parse({status:"prepared",input,document:ref,range:{start:0,end:document.text.length}});
  }
}
