import { readFile } from "node:fs/promises";
/** Timestamp must be sampled after asynchronous I/O: a concurrent heartbeat can be newer than the scan start. */
export async function readWorkerReady(path:string,pid:number|undefined){
 try{const h=JSON.parse(await readFile(path,"utf8")),age=Date.now()-Date.parse(h.reportedAt);
  return Boolean(pid)&&h.pid===pid&&h.event==="WORKER_RUNNING"&&age>=0&&age<15000;
 }catch{return false;}
}
