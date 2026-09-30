// Fault-injection child: terminated writer/owner never gives admission permission to another process.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FixedLanePool, FileLanePoolStore } from "@crawl-automation/v3-acquisition";
const [root,mode,lanesJson]=process.argv.slice(2), lanes=JSON.parse(lanesJson!);
const pool=new FixedLanePool(lanes,new FileLanePoolStore(root!),{verify:async lane=>{
  if(mode==="writer") {await writeFile(join(root!,"crash-intent.json"),"{}",{flag:"wx",mode:0o600});process.exit(17);}
  return {topologyValid:true,observedIp:lane.expectedIp};
}});
const grant=await pool.acquire("crashed-owner",AbortSignal.timeout(5000));
await pool.retainFiles(grant,["planned-file"]);
process.exit(17);
