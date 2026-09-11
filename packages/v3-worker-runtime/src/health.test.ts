import { mkdtemp, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkerHealthFile } from "./health.js";
it("rejects relative paths",()=>{expect(()=>new WorkerHealthFile("health.json")).toThrow();});
it("serializes health writes as private complete receipts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"v3-health-test-")),path=join(root,"health.json"),health=new WorkerHealthFile(path);
  await Promise.all([health.report({event:"WORKER_RUNNING"}),health.report({event:"WORKER_STOPPED"}),health.flush()]);
  const record=JSON.parse(await readFile(path,"utf8"));expect(record.event).toBe("WORKER_STOPPED");expect(record.pid).toBe(process.pid);
  expect((await stat(path)).mode&0o077).toBe(0);expect(await readdir(root)).toEqual(["health.json"]);
});
