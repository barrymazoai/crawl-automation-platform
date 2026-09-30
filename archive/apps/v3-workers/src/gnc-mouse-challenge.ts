import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { RenderedPageInteraction, RenderedInteraction } from "@crawl-automation/v3-acquisition";
import type { GncAcquireInput } from "@crawl-automation/v3-contracts";
import { GncCaptureEvidence, parseGncProduct } from "@crawl-automation/v3-channels";

const exec = promisify(execFile);
const targetUrl = "https://www.gnc.com/energy/613701.html";
const title = "Access to this page has been denied";
type Window = { pid: number; windowId: number; title: string; bounds: number[] };
export type MouseConfig = { browserPid: number; profilePath: string };
const reject = (code: string): never => { throw Error(code); };
export function nativeReceiptComplete(name: string, lines: any[]) {
  if (lines.some(l=>l?.ok === false)) return true;
  return name === "inspect"
    ? lines.length === 1 && ["accessibility","postEventAccess","screenRecording"].every(k=>typeof lines[0]?.[k] === "boolean") && Array.isArray(lines[0].windows)
    : lines.some(l=>l?.event === "DOWN_POSTED") && lines.some(l=>l?.event === "UP_POSTED");
}
export function holdNodes(root: any) {
  const result:any[]=[];let count=0;
  const exact=(s:string)=>/^(?:press\s*(?:&|and)\s*hold|按住)$/i.test(s.trim());
  function walk(n:any,depth=0): string {
    if(!n || ++count>10000 || depth>80)reject("GNC.MOUSE_DOM_LIMIT");
    const attrs:Record<string,string>=Object.create(null);for(let i=0;i<(n.attributes?.length??0);i+=2)attrs[n.attributes[i]]=n.attributes[i+1];
    const content=[...(n.children??[]),...(n.shadowRoots??[]),...(n.contentDocument?[n.contentDocument]:[])].map(c=>walk(c,depth+1)).join(" ");
    const text=n.nodeType===3?n.nodeValue??"":content;
    if((n.nodeName==="BUTTON" || attrs.role==="button") && (exact(attrs["aria-label"]??"") || exact(text)))result.push(n);
    return text;
  }
  walk(root);return result;
}
export async function locateHold(tab:RenderedInteraction) {
  const root=await tab.document(),nodes=holdNodes(root),hits=[];
  const diagnostics:any[]=[];
  function inspect(n:any) {
    const attrs:Record<string,string>=Object.create(null);for(let i=0;i<(n.attributes?.length??0);i+=2)attrs[n.attributes[i]]=n.attributes[i+1];
    if(diagnostics.length<20&&(n.nodeName==="IFRAME"||n.nodeName==="BUTTON"||attrs.role))diagnostics.push({tag:n.nodeName,role:attrs.role,label:attrs["aria-label"]?.slice(0,150),title:attrs.title?.slice(0,100),childDocument:!!n.contentDocument});
    for(const c of [...(n.children??[]),...(n.shadowRoots??[]),...(n.contentDocument?[n.contentDocument]:[])])inspect(c);
  }
  inspect(root);
  for(const n of nodes) {
    try {
      const q=(await tab.box(n.nodeId))?.border;
      if(!Array.isArray(q)||q.length!==8||!q.every(Number.isFinite))continue;
      const xs=[q[0],q[2],q[4],q[6]],ys=[q[1],q[3],q[5],q[7]];
      const x=Math.min(...xs),y=Math.min(...ys),width=Math.max(...xs)-x,height=Math.max(...ys)-y;
      if(width<=0||height<=0)continue;
      const hit=await tab.hit(x+width/2,y+height/2);
      const descendants=(node:any):number[]=>[node.backendNodeId,...(node.children??[]).flatMap(descendants),...(node.shadowRoots??[]).flatMap(descendants)];
      if(!descendants(n).includes(hit.backendNodeId))continue;
      hits.push({x,y,width,height});
    } catch { /* Detached or obscured node is not a target. */ }
  }
  const info:any=await tab.evaluate(`({url:location.href,title:document.title})`);
  const g=await tab.geometry(),b=g.bounds,l=g.layout,v=g.visual;
  return {...info,hits,candidateCount:nodes.length,diagnostics,metrics:{screenX:b.left,screenY:b.top,outerWidth:b.width,outerHeight:b.height,innerWidth:l.clientWidth,innerHeight:l.clientHeight,scale:v.scale}};
}

export function holdRequest(snapshot: any, window: Window, pid: number) {
  if (snapshot?.url !== targetUrl || snapshot.title !== title || window.title !== title || window.pid !== pid) reject("GNC.MOUSE_TARGET_MISMATCH");
  if (!Array.isArray(snapshot.hits) || snapshot.hits.length !== 1) reject("GNC.MOUSE_TARGET_UNRESOLVED");
  const m = snapshot.metrics, r = snapshot.hits[0], b = window.bounds as [number,number,number,number];
  if (!m || !r || b.length !== 4 || ![...b, ...Object.values(m), ...Object.values(r)].every(v => typeof v === "number" && Number.isFinite(v))) reject("GNC.MOUSE_GEOMETRY_INVALID");
  if (b[2] <= 0 || b[3] <= 0 || m.innerWidth <= 0 || m.innerHeight <= 0 || m.scale !== 1 || Math.abs(m.screenX-b[0]) > 2 || Math.abs(m.screenY-b[1]) > 2 ||
      Math.abs(m.outerWidth-b[2]) > 2 || Math.abs(m.outerHeight-b[3]) > 2 ||
      m.outerHeight-m.innerHeight < 0 || m.outerHeight-m.innerHeight > 180 || Math.abs(m.outerWidth-m.innerWidth) > 4 ||
      r.width < 80 || r.height < 20 || r.width > 600 || r.height > 150 || r.x < 0 || r.y < 0 ||
      r.x+r.width > m.innerWidth || r.y+r.height > m.innerHeight) reject("GNC.MOUSE_GEOMETRY_INVALID");
  const xRatio = (r.x+r.width/2+(m.outerWidth-m.innerWidth)/2)/b[2];
  const yRatio = (m.outerHeight-m.innerHeight+r.y+r.height/2)/b[3];
  if (xRatio < .05 || xRatio > .95 || yRatio < .15 || yRatio > .9) reject("GNC.MOUSE_GEOMETRY_INVALID");
  // Reuse the existing native tool's multi-waypoint feature. Derive points from
  // this observed button/viewport, never yesterday's window coordinates.
  const cx=r.x+r.width/2, cy=r.y+r.height/2;
  const point=(x:number,y:number)=>[
    Math.max(.05,Math.min(.95,(Math.max(8,Math.min(m.innerWidth-8,x))+(m.outerWidth-m.innerWidth)/2)/b[2])),
    Math.max(.15,Math.min(.9,(m.outerHeight-m.innerHeight+Math.max(8,Math.min(m.innerHeight-8,y)))/b[3])),
  ];
  const movePath=[point(cx-r.width*1.2,cy+r.height*.8),point(cx-r.width*.9,cy-r.height*.5),point(cx-r.width*.3,cy+r.height*.1)];
  return { pid, windowId: window.windowId, bounds:b, expectedTitle:title, expectedUrl:targetUrl,
    xRatio, yRatio, movePath, moveMs:2200, settleMs:300, holdMs:10000 };
}

export function gncMouseInteraction(task: GncAcquireInput, config: MouseConfig, evidence: GncCaptureEvidence): RenderedPageInteraction {
  return async (initial, tab, signal) => {
    // Only the currently approved SKU and explicit challenge, never another adapter/page.
    if (task.capture.kind !== "product" || task.capture.url !== targetUrl || initial.url !== targetUrl) return;
    if (!/<title[^>]*>\s*Access to this page has been denied\s*<\/title>/i.test(initial.html)) return;
    const base = `v3/gnc-mouse/${task.capture.operationId}`;
    const publish = async (name: string, value: unknown) => {
      const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
      await evidence.retain(`${base}/${name}`, bytes, name.endsWith("html") ? "text/html" : "application/json", signal);
      await evidence.publish(`${base}/${name}`, bytes, name.endsWith("html") ? "text/html" : "application/json", signal);
    };
    await publish("before.html", initial.html);
    const result: Record<string, unknown> = { policy:"gnc-native-mouse/1", operationId:task.capture.operationId,
      browserId:initial.browserId, targetId:initial.targetId, binding:task.capture.binding, attempts:0, codexCalls:0, at:new Date().toISOString() };
    try {
      result.stage="process-check";
      if (process.platform !== "darwin") reject("GNC.MOUSE_PLATFORM_UNSUPPORTED");
      signal.throwIfAborted();
      const ps = (await exec("/bin/ps", ["-p", String(config.browserPid), "-o", "command="], { signal })).stdout.trim();
      if (!ps.startsWith("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ") ||
          !ps.split(/\s+/).includes(`--user-data-dir=${config.profilePath}`) || /--headless(?:\b|=)/.test(ps)) reject("GNC.MOUSE_BROWSER_MISMATCH");
      const dir = await mkdtemp(join(dirname(config.profilePath), "mouse-attempt-"));
      result.localAttemptDirectory=dir;
      const invoke = async (name: string, args: string[]) => {
        const stdout = join(dir, `${name}.stdout`), stderr = join(dir, `${name}.stderr`);
        await writeFile(stdout, "", { flag:"wx", mode:0o600 }); await writeFile(stderr, "", { flag:"wx", mode:0o600 });
        let launchError: unknown;
        try { await exec("/usr/bin/open", ["-n", "-g", "--stdout", stdout, "--stderr", stderr, "/Applications/Crawler Mouse.app", "--args", ...args], { timeout:5000, signal }); }
        catch(error) { launchError=error; }
        signal.throwIfAborted();
        let lines: any[] = [];
        // Do not use open -W: LaunchServices kevent can fail after successful launch.
        // Each invocation has fresh private output files; partial output is never success.
        for(let n=0;n<80;n++) {
          const raw=await readFile(stdout,"utf8");
          if(raw.length>65536)reject("GNC.MOUSE_OUTPUT_LIMIT");
          try { lines=raw.trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); } catch { lines=[]; }
          if(nativeReceiptComplete(name,lines))break;
          await delay(250,undefined,{signal});
        }
        if (launchError) {
          const e=launchError as any;
          await writeFile(join(dir,`${name}-launcher-error.json`),JSON.stringify({message:e.message,code:e.code,signal:e.signal,killed:e.killed}),{flag:"wx",mode:0o600});
          result.launcherErrorCode=e.code ?? "UNKNOWN";
          // LaunchServices' exit is not the native tool's receipt. Never repeat input;
          // only accept complete output from this invocation's newly created files.
          if (!nativeReceiptComplete(name,lines)) throw launchError;
        }
        if(!nativeReceiptComplete(name,lines))reject("GNC.MOUSE_RECEIPT_UNKNOWN");
        return lines;
      };
      await tab.activate();
      result.stage="native-inspection";
      const [inspection] = await invoke("inspect", ["--inspect-gnc"]);
      if (!inspection?.accessibility || !inspection.postEventAccess || !inspection.screenRecording) reject("GNC.MOUSE_PERMISSION_REQUIRED");
      const windows = inspection.windows.filter((w: Window) => w.pid === config.browserPid);
      if (windows.length !== 1) reject("GNC.MOUSE_TARGET_UNRESOLVED");
      let snapshot: any;
      result.stage="button-location";
      for (let n=0;n<60;n++) {
        snapshot = await locateHold(tab);
        if (snapshot?.hits?.length) break;
        await delay(500, undefined, {signal});
      }
      await publish("location.json", snapshot ?? {missing:true});
      const observed=await tab.snapshot();
      await publish("located.html",observed.html);
      if(observed.screenshot) {
        await evidence.retain(`${base}/located.png`,observed.screenshot,"image/png",signal);
        await evidence.publish(`${base}/located.png`,observed.screenshot,"image/png",signal);
      }
      result.stage="geometry-check";
      const request = holdRequest(snapshot, windows[0], config.browserPid);
      await publish("target.json", {request, snapshot});
      // Exact operation marker prevents repeat OS input after unknown completion.
      const marker = Buffer.from(JSON.stringify({operationId:task.capture.operationId,request}));
      if (await evidence.deps.remote.create(`${base}/attempt.json`, marker, "application/json", signal) !== "created") reject("GNC.MOUSE_ATTEMPT_UNKNOWN");
      const checked = await evidence.deps.remote.read(`${base}/attempt.json`, marker.length, signal);
      if (!checked || !Buffer.from(checked).equals(marker)) reject("GNC.MOUSE_ATTEMPT_UNKNOWN");
      result.attempts=1;
      result.stage="native-hold";
      result.events = await invoke("hold", ["--hold", JSON.stringify(request)]);
      if (!(result.events as any[]).some(e=>e.event === "UP_POSTED") || (result.events as any[]).some(e=>e.ok === false)) reject("GNC.MOUSE_INPUT_FAILED");
      result.stage="product-check";
      for (let n=0;n<30;n++) {
        await delay(500, undefined, {signal});
        let page;
        try {
          page = await tab.snapshot();
          if (page.url !== targetUrl) reject("GNC.MOUSE_TARGET_MISMATCH");
          parseGncProduct(page.html, page.url, "613701");
          if (page.status !== 200) continue;
        } catch { signal.throwIfAborted(); continue; }
        await publish("after.html", page.html);
        result.status="product_verified"; result.afterSha256=createHash("sha256").update(page.html).digest("hex"); break;
      }
      result.status ??= "not_passed";
      // Preserve the final challenge (including frame DOM and screenshot), not
      // only the pre-click page. This distinguishes a retry prompt from no input.
      if(result.status === "not_passed") {
        const final=await tab.snapshot();
        await publish("after.html",final.html);
        await publish("after-dom.json",await tab.document());
        if(final.screenshot) {
          await evidence.retain(`${base}/after.png`,final.screenshot,"image/png",signal);
          await evidence.publish(`${base}/after.png`,final.screenshot,"image/png",signal);
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      result.status="not_passed";
      result.code=error instanceof Error && /^GNC\.MOUSE_[A-Z_]+$/.test(error.message) ? error.message : "GNC.MOUSE_EXECUTION_UNKNOWN";
      if (error instanceof Error) {
        result.errorType=error.name;
        const reason=(error as any).reason;
        if (typeof reason === "string") result.reason=reason.slice(0,240);
        const message=error.message;
        if (/^(?:SOURCE|GNC)\.[A-Z_]+$/.test(message)) result.causeCode=message;
        const code=(error as any).code;
        if(typeof code === "number" || (typeof code === "string" && /^[A-Z_]+$/.test(code))) result.systemCode=code;
        result.killed=(error as any).killed===true;
      }
    }
    await publish("result.json", result);
    // The ordinary GNC parser still validates the final page and enters Review on failure.
  };
}
