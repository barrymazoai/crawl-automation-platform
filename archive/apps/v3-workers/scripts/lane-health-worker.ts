// Process-lifecycle acceptance fixture, NOT a business/Temporal Worker.
import { readFile, writeFile } from "node:fs/promises";
import { CdpRenderedBrowser, StaticProxyTransport } from "@crawl-automation/v3-acquisition";
import assert from "node:assert/strict";
const [configPath] = process.argv.slice(2);
assert.ok(configPath);
const c = JSON.parse(await readFile(configPath,"utf8"));
let observedIp = "";
if(c.mode === "browser") {
  const browser = new CdpRenderedBrowser({...c.browser,egressId:c.egressId,allowedOrigins:["https://api.ipify.org"]});
  const page = await browser.read("https://api.ipify.org/",AbortSignal.timeout(45000));
  assert.equal(page.status,200);
  observedIp = page.html.match(/<pre[^>]*>(\d+\.\d+\.\d+\.\d+)<\/pre>/)?.[1] ?? "";
} else {
  assert.equal(c.mode,"file");
  const response = await new StaticProxyTransport(c.egressId,c.proxyUrl).get(new URL("https://api.ipify.org/"),undefined,{},AbortSignal.timeout(30000));
  try {
    assert.equal(response.status,200); const chunks:Uint8Array[]=[]; let size=0;
    for await(const b of response.body){size+=b.length;assert.ok(size<=128);chunks.push(b);}
    observedIp=Buffer.concat(chunks).toString("utf8").trim();
  } finally {response.close();}
}
assert.equal(observedIp,c.expectedIp);
await writeFile(c.output,JSON.stringify({mode:c.mode,observedIp,pid:process.pid,sessionId:c.sessionId}),{flag:"wx",mode:0o600});
console.log(JSON.stringify({event:"WORKER_RUNNING",fixture:true}));
const timer=setInterval(()=>{},1000);
process.once("SIGTERM",()=>{clearInterval(timer);process.exitCode=0;});
