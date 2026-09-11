import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { msToTs, tsToDate } from "@temporalio/common/lib/time";
import { ScheduleTick, type ScheduleTickResult } from "@crawl-automation/v3-contracts";
import { startTestDatabase } from "../integration/postgres.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { TemporalSchedules } from "../src/schedules/service.js";
import { scheduleSourceReader } from "../src/schedules/source-reader.js";
import { tickRequestId } from "../src/schedules/tick.js";
import { createApp } from "../src/http/app.js";

let env: TestWorkflowEnvironment, db: Awaited<ReturnType<typeof startTestDatabase>>;
let brands: PostgresBrands, submissions: PostgresSubmissions, service: TemporalSchedules;
const queue = `schedule-proof-${randomUUID()}`, owned: string[] = [];
const rule = { hour: 2, minute: 30, timezone: "America/New_York" };
beforeAll(async () => {
  db = await startTestDatabase(); brands = new PostgresBrands(db.pool); submissions = new PostgresSubmissions(db.pool);
  env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false, executable: { type: "cached-download", version: "v1.8.3" } } });
  service = new TemporalSchedules(env.client, { clusterId: "schedule-test", namespace: "default", taskQueue: queue }, scheduleSourceReader(db.pool));
});
afterAll(async () => { if (env) { for (const id of owned) await env.client.schedule.getHandle(id).delete().catch(() => {}); await env.teardown(); } await db?.close(); });
async function fixture() {
  const brand = (await brands.create({ name: `Schedule ${randomUUID()}`, note: "Isolated synthetic fixture" }, randomUUID())).value;
  const s = (await brands.createSource(brand.id,{ channel: "dtc",region: "US",url: "https://schedule.example/products" },randomUUID())).value;
  const source = (await brands.toggleSource(brand.id,s.id,{ enabled: true,revision: s.revision },randomUUID())).value;
  return { brand,source };
}
async function plan() { const f = await fixture(); const key = randomUUID(); const p = await service.create(f.brand.id,f.source.id,{rule,sourceRevision:f.source.revision},key); owned.push(p.scheduleId); return {...f,p,key}; }
async function trigger(scheduleId: string) {
  const handle = env.client.schedule.getHandle(scheduleId);
  // Temporal appends second-precision timestamps to manually triggered IDs.
  // Distinct tick test cases must use distinct seconds.
  await delay(1100);
  const before = (await handle.describe()).info.numActionsTaken;
  await handle.trigger("SKIP");
  let workflowId = "";
  await vi.waitFor(async () => { const desc = await handle.describe(); expect(desc.info.numActionsTaken).toBeGreaterThan(before); workflowId = desc.info.recentActions.at(-1)!.action.workflow.workflowId; }, { timeout:10000,interval:100 });
  return env.client.workflow.getHandle(workflowId).result() as Promise<ScheduleTickResult>;
}
describe("real Temporal Schedule and shared business intake", () => {
  it("creates paused, replays create safely, and persists modification/pause revisions", async () => {
    const {brand,source,p,key} = await plan(); expect(p.paused).toBe(true);
    expect(await service.create(brand.id,source.id,{rule,sourceRevision:2},key)).toEqual(p);
    const update = {rule:{...rule,hour:4},sourceRevision:2,revision:1,paused:false}, updateKey=randomUUID();
    const changed = await service.update(brand.id,source.id,update,updateKey); expect(changed.definition.revision).toBe(2); expect(changed.paused).toBe(false);
    expect((await service.update(brand.id,source.id,update,updateKey)).definition).toEqual(changed.definition);
    await expect(service.update(brand.id,source.id,update,randomUUID())).rejects.toMatchObject({code:"SCHEDULE_CONFLICT"});
    expect((await service.update(brand.id,source.id,{...update,revision:2,paused:true},randomUUID())).paused).toBe(true);
  });
  it("concurrent editors with one revision cannot silently overwrite each other", async () => {
    const {brand,source}=await plan();
    const results=await Promise.allSettled([5,6].map(hour=>service.update(brand.id,source.id,{rule:{...rule,hour},sourceRevision:2,revision:1,paused:true},randomUUID())));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect((await service.get(brand.id,source.id))?.definition.revision).toBe(2);
  });
  it("actual tick accepts once; a later occupied tick stays skipped even after release", async () => {
    const {p,source,brand}=await plan(); const ticks:ScheduleTick[]=[];
    const worker=await Worker.create({connection:env.nativeConnection,namespace:"default",taskQueue:queue,workflowsPath:fileURLToPath(new URL("../src/schedules/workflow.ts",import.meta.url)),
      activities:{acceptScheduleTick:async(tick:ScheduleTick)=>{ ticks.push(tick); return (await submissions.acceptScheduled(tick)).value; }}});
    await worker.runUntil(async()=>{
      const first=await trigger(p.scheduleId); expect(first.state).toBe("ACCEPTED");
      await expect(submissions.accept(brand.id,source.id,{sourceRevision:2},randomUUID())).rejects.toMatchObject({code:"SOURCE_BUSY"});
      const second=await trigger(p.scheduleId); expect(second).toMatchObject({state:"SKIPPED",reason:"SOURCE_BUSY"});
      expect(second.requestId).not.toBe(first.requestId);
      expect((await submissions.get(first.requestId)).snapshot.sourceId).toBe(source.id);
      // Isolated fixture-only release to test the permanent skipped receipt; no
      // production guard-clear API is added or called by the schedule module.
      await db.pool.query("DELETE FROM source_submission_guard WHERE source_id=$1 AND request_id=$2",[source.id,first.requestId]);
      expect((await submissions.acceptScheduled(ticks[1]!)).value).toEqual(second);
      expect(await submissions.active(brand.id,source.id)).toBeNull();
      expect(tickRequestId({...ticks[0]!,workflowId:ticks[0]!.workflowId+"-reset"})).toBe(first.requestId);
    });
  });
  it("a source revision change records REVIEW and pauses the actual Schedule on failure", async()=>{
    const {p,brand,source}=await plan();
    await service.update(brand.id,source.id,{rule,sourceRevision:2,revision:1,paused:false},randomUUID());
    await brands.toggleSource(brand.id,source.id,{enabled:false,revision:2},randomUUID());
    const worker=await Worker.create({connection:env.nativeConnection,namespace:"default",taskQueue:queue,workflowsPath:fileURLToPath(new URL("../src/schedules/workflow.ts",import.meta.url)),
      activities:{acceptScheduleTick:async(tick:ScheduleTick)=>(await submissions.acceptScheduled(tick)).value}});
    await worker.runUntil(async()=>{
      await expect(trigger(p.scheduleId)).rejects.toMatchObject({ cause: { type: "SCHEDULE_REVIEW" } });
      await vi.waitFor(async()=>expect((await service.get(brand.id,source.id))?.paused).toBe(true),{timeout:10000,interval:100});
      expect(await submissions.active(brand.id,source.id)).toBeNull();
    });
  });
  it("server calendar handles DST gaps and repeated wall-clock hours explicitly",async()=>{
    const {p,brand,source}=await plan();
    const matching=async(start:string,end:string)=>{
      const result=await env.client.workflowService.listScheduleMatchingTimes({namespace:"default",scheduleId:p.scheduleId,startTime:msToTs(Date.parse(start)),endTime:msToTs(Date.parse(end))});
      return result.startTime?.map(t=>tsToDate(t).toISOString())??[];
    };
    expect(await matching("2027-03-14T00:00:00Z","2027-03-15T00:00:00Z")).toEqual([]);
    await service.update(brand.id,source.id,{rule:{...rule,hour:1},sourceRevision:2,revision:1,paused:true},randomUUID());
    expect(await matching("2027-11-07T00:00:00Z","2027-11-08T00:00:00Z")).toEqual(["2027-11-07T05:30:00.000Z","2027-11-07T06:30:00.000Z"]);
  });
  it("HTTP boundary is disabled by default and validates request keys and input",async()=>{
    const {brand,source}=await fixture(), token="isolated-schedule-http-token-long-enough";
    const path=`/api/v3/brands/${brand.id}/sources/${source.id}/schedule`;
    const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json","Idempotency-Key":randomUUID()};
    const closed=createApp(brands,token);
    expect((await closed.request(path)).status).toBe(401);
    expect(await(await closed.request(path,{headers})).json()).toEqual({enabled:false,item:null});
    expect((await closed.request(path,{method:"POST",headers,body:JSON.stringify({rule,sourceRevision:2})})).status).toBe(503);
    const app=createApp(brands,token,{schedules:service});
    const res=await app.request(path,{method:"POST",headers,body:JSON.stringify({rule,sourceRevision:2})});
    expect(res.status).toBe(201); owned.push((await res.json()).scheduleId);
  });
});
