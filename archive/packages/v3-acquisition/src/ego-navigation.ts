import { EgoBrowserConfigSchema, EgoCliRunner, EgoRenderedBrowser, type EgoBrowserConfig, type EgoCommandRunner } from "./ego-browser.js";
import { BrowserError, type RenderedBrowser, type RenderedPage } from "./browser.js";
import { permittedUrl } from "./network.js";

/** Navigation is separate from the existing read-only adapter. Caller owns a persistent exclusive lease. */
export class EgoNavigatingBrowser implements RenderedBrowser {
  readonly sessionId:string;
  private readonly config:EgoBrowserConfig;
  private busy=false;
  constructor(config:EgoBrowserConfig,readonly egressId:string,private readonly allowedUrls:readonly string[],
    private readonly runner:EgoCommandRunner=new EgoCliRunner()) {
    this.config=EgoBrowserConfigSchema.parse(config);this.sessionId=config.sessionId;
    if(!allowedUrls.length||allowedUrls.length>100)throw new BrowserError("SOURCE.BROWSER_CONFIG");
    for(const url of allowedUrls)if(permittedUrl(url,["https://www.gnc.com"]).href!==url)throw new BrowserError("SOURCE.BROWSER_CONFIG");
  }
  async read(url:string,signal:AbortSignal):Promise<RenderedPage> {
    if(!this.allowedUrls.includes(url))throw new BrowserError("SOURCE.BROWSER_URL_REJECTED");
    if(this.busy)throw new BrowserError("SOURCE.BROWSER_BUSY");
    signal.throwIfAborted();this.busy=true;
    const c=this.config, bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
    const selection=`const selected=tabs.filter(t=>t.targetId===${JSON.stringify(c.targetId)}${c.sdk==="2"?"&&t.label":""});if(selected.length!==1)throw Error('EGO_TARGET_MISMATCH');`;
    const script=c.sdk==="1"?`await useOrCreateTaskSpace(${c.taskSpaceId});const tabs=await listTabs();${selection}
await switchTab(selected[0].targetId);if(selected[0].url!==${JSON.stringify(url)})await gotoAndWait(${JSON.stringify(url)},{timeout:20});const info=await pageInfo();
const snapshot={url:info.url,targetId:selected[0].targetId,taskSpaceId:${c.taskSpaceId}};`:
      `const task=await taskSpace(${c.taskSpaceId});const tabs=await task.tabs();${selection}
const page=task.page(selected[0].label);if(selected[0].url!==${JSON.stringify(url)})await page.goto(${JSON.stringify(url)},{timeout:20000});
const snapshot={url:await page.url(),targetId:selected[0].targetId,taskSpaceId:${c.taskSpaceId}};`;
    try {
      const receipt=await this.runner.run(c.cliPath,script,bounded) as Record<string,unknown>;
      if(receipt?.url!==url||receipt.targetId!==c.targetId||receipt.taskSpaceId!==c.taskSpaceId)throw new BrowserError("SOURCE.BROWSER_INSTANCE_MISMATCH");
      return await new EgoRenderedBrowser(c,this.egressId,["https://www.gnc.com"],this.runner).read(url,bounded);
    } finally {this.busy=false;}
  }
}
