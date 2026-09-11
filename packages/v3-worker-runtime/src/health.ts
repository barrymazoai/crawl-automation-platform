import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
/** Optional private supervisor receipt; never contains config, credential or business payload. */
export class WorkerHealthFile {
  private chain = Promise.resolve();
  private state: Record<string,string|number> = {event:"WORKER_STARTING"};
  constructor(private readonly path:string) {if(!isAbsolute(path))throw Error("Absolute health path required");}
  report(event:Record<string,string|number>) {this.state=event;return this.flush();}
  flush() {
    const record={...this.state,pid:process.pid,reportedAt:new Date().toISOString()};
    this.chain=this.chain.catch(()=>{}).then(async()=>{
      const temp=`${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp,JSON.stringify(record),{mode:0o600,flag:"wx"});await rename(temp,this.path);
    });return this.chain;
  }
}
