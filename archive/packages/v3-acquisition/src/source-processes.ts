import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LanePoolError } from "./lane-pool.js";
import type { OwnedSourceProcess, SourceProcessDriver } from "./lane-session.js";
import { acquireBrowserProfile } from "./browser-profile.js";

const fail = () => new LanePoolError("NETWORK.LANE_LEASE_INVALID");
/** Actual owning runtime adapter. No shell, no arbitrary PID adoption, no restart loop.
 * Chrome gets a private profile and fixed proxy; optional profilesRoot persists one profile per lane.
 * User's personal Chrome data is never adopted. Unconfirmed process exit keeps the profile locked.
 */
export class NodeSourceProcesses implements SourceProcessDriver {
  constructor(private readonly config: { chromeExecutable: string; headless: boolean; profilesRoot?: string; startupMs?: number; stopMs?: number }) {
    if (!isAbsolute(config.chromeExecutable) || (config.profilesRoot !== undefined && !isAbsolute(config.profilesRoot)) || process.platform === "win32") throw fail();
  }
  async browser(input: Parameters<SourceProcessDriver["browser"]>[0]) {
    const held = this.config.profilesRoot ? await acquireBrowserProfile(this.config.profilesRoot,input.grant,input.proxyUrl) : undefined;
    const profile = held?.path ?? join(input.root,"profile");
    if (!held) await mkdir(profile,{mode:0o700});
    // A reused profile may contain a previous endpoint. Never adopt that browser as our new child.
    let previousPortFile = "";
    try { previousPortFile = await readFile(join(profile,"DevToolsActivePort"),"utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await held?.release(); throw fail(); } }
    // If launch itself is uncertain the durable lock remains held for inspection.
    const child = await this.launch(this.config.chromeExecutable,[`--user-data-dir=${profile}`,"--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",`--proxy-server=${input.proxyUrl}`,"--no-first-run","--no-default-browser-check",
      "--disable-background-networking","--disable-component-update","--disable-sync",
      ...(this.config.headless?["--headless=new"]:[]),"about:blank"],input.root);
    const stop = async () => {
      if (!await child.stop()) return false;
      await held?.release(); return true;
    };
    try {
      let endpoint = "", instanceId = "";
      await this.until(async()=>{
        if (exited(child.child)) throw fail();
        try {
          const portFile = await readFile(join(profile,"DevToolsActivePort"),"utf8");
          if (portFile === previousPortFile) return false;
          const [port,path] = portFile.trim().split("\n");
          if (!/^\d{1,5}$/.test(port??"") || !/^\/devtools\/browser\/[a-f0-9-]+$/.test(path??"")) return false;
          endpoint=`http://127.0.0.1:${port}`;
          const response=await fetch(`${endpoint}/json/version`,{redirect:"error",signal:AbortSignal.timeout(1000)});
          const v=await response.json() as any;
          if (!response.ok || v.webSocketDebuggerUrl!==endpoint.replace("http:","ws:")+path) return false;
          instanceId=path!.split("/").at(-1)!; return true;
        } catch { return false; }
      });
      return {pid:child.pid,config:{endpoint,instanceId,sessionId:input.grant.sessionId},stop};
    } catch { await stop(); throw fail(); }
  }
  async worker(input: Parameters<SourceProcessDriver["worker"]>[0]): Promise<OwnedSourceProcess> {
    const child=await this.launch(process.execPath,[input.spec.entry,...(input.spec.args??[])],input.root,input.spec.env);
    try {
      await this.until(async()=>{
        if(exited(child.child)) throw fail();
        const text=await readFile(join(input.root,"process.log"),"utf8");
        return text.split("\n").some(line=>{try{return JSON.parse(line).event==="WORKER_RUNNING";}catch{return false;}});
      });
      return {pid:child.pid,stop:child.stop};
    } catch { await child.stop(); throw fail(); }
  }
  private async until(check:()=>Promise<boolean>, timeout=this.config.startupMs??30000) {
    const end=Date.now()+timeout;
    while(!await check()){if(Date.now()>=end)throw fail();await delay(100);}
  }
  private async launch(executable:string,args:string[],root:string,env:Record<string,string>={}) {
    const log=await open(join(root,"process.log"),"ax",0o600);
    const child=spawn(executable,args,{env:{...process.env,...env},detached:true,stdio:["ignore",log.fd,log.fd]});
    try {await new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",()=>reject(fail()));});}
    finally {await log.close();}
    const pid=child.pid!;
    const groupGone=()=>{try{process.kill(-pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==="ESRCH";}};
    const stop=async()=>{
      // Only a process group created by this live adapter instance can be signalled.
      if(!exited(child)) {try{process.kill(-pid,"SIGTERM");}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")return false;}}
      try {await this.until(async()=>exited(child)&&groupGone(),this.config.stopMs??15000);return true;}
      catch {return false;} // No unknown descendant reclamation/automatic SIGKILL/relaunch.
    };
    return {pid,child,stop};
  }
}
function exited(child:ChildProcess){return child.exitCode!==null||child.signalCode!==null;}
