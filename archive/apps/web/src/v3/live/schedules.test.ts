import { afterEach, expect, it, vi } from "vitest";
import { Source } from "@crawl-automation/v3-contracts";
import { prepareScheduleIntent, readScheduleIntent, sendScheduleIntent } from "./schedules";
const source=Source.parse({id:"10000000-0000-4000-8000-000000000001",brandId:"10000000-0000-4000-8000-000000000002",channel:"dtc",region:"US",url:"https://synthetic.example/",enabled:true,revision:2,createdAt:"2026-09-06T00:00:00Z",updatedAt:"2026-09-06T00:00:00Z"});
const input={rule:{hour:4,minute:0,timezone:"UTC"},sourceRevision:2};
const memory=()=>{const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}} as unknown as Storage;};
afterEach(()=>vi.unstubAllGlobals());
it("freezes and restores the same plan mutation before any request",()=>{
  const storage=memory();const p=prepareScheduleIntent(storage,source,input,"POST");expect(readScheduleIntent(storage)).toEqual(p);
  expect(()=>prepareScheduleIntent(storage,source,input,"POST")).toThrow();
});
it("does not proceed on corrupt or full browser storage",()=>{
  expect(()=>readScheduleIntent({getItem:()=>"{"} as unknown as Storage)).toThrow();
  const storage=memory();storage.setItem=()=>{throw Error("full");};expect(()=>prepareScheduleIntent(storage,source,input,"POST")).toThrow("full");
});
it("retries errors with the original key and rejects a foreign receipt",async()=>{
  const storage=memory(),p=prepareScheduleIntent(storage,source,input,"POST");
  const fetcher=vi.fn().mockRejectedValueOnce(Error("lost")).mockResolvedValueOnce(Response.json({scheduleId:`v3-source-${source.id}`,definition:{version:1,clusterId:"test",brandId:source.brandId,sourceId:source.id,...input,revision:1,commandId:crypto.randomUUID(),activityQueue:"test"},paused:true,overlap:"SKIP",catchupWindowMs:10000,pauseOnFailure:true,nextTimes:[],actionsTaken:0,overlapSkipped:0,missedCatchup:0},{status:201}));
  vi.stubGlobal("fetch",fetcher);await expect(sendScheduleIntent(p)).rejects.toThrow();
  expect(readScheduleIntent(storage)).toEqual(p);await expect(sendScheduleIntent(p)).rejects.toMatchObject({code:"SCHEDULE_RECEIPT_MISMATCH"});
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);expect(fetcher.mock.calls[0]![1].headers).toEqual(fetcher.mock.calls[1]![1].headers);
});
