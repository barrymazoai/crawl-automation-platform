import { expect, it, vi } from "vitest";
import { Id, ScheduleTick } from "@crawl-automation/v3-contracts";
import { tickRequestId } from "./tick.js";
import { scheduleActivities } from "./activities.js";
const sourceId="10000000-0000-4000-8000-000000000001";
const tick=ScheduleTick.parse({definition:{version:1,clusterId:"test",brandId:"10000000-0000-4000-8000-000000000002",sourceId,sourceRevision:2,revision:1,commandId:"10000000-0000-4000-8000-000000000003",activityQueue:"accept",rule:{hour:1,minute:30,timezone:"America/New_York"}},namespace:"default",scheduleId:`v3-source-${sourceId}`,workflowId:`v3-tick-${sourceId}-2027-11-07T05:30:00Z`,scheduledAt:"2027-11-07T05:30:00.000Z"});
it("uses a valid UUID stable across replay but distinct for repeated DST hours",()=>{
  expect(Id.parse(tickRequestId(tick))).toBe(tickRequestId({...tick}));
  expect(tickRequestId({...tick,scheduledAt:"2027-11-07T06:30:00.000Z"})).not.toBe(tickRequestId(tick));
  expect(tickRequestId({...tick,definition:{...tick.definition,clusterId:"other"}})).not.toBe(tickRequestId(tick));
});
it("rejects forged schedule/source identity before storage",()=>{
  expect(()=>tickRequestId({...tick,scheduleId:"v3-source-10000000-0000-4000-8000-000000000004"})).toThrow();
});
it("Activity factory rejects cross-scope input before invoking the injected repository",async()=>{
  const acceptScheduled=vi.fn();const activities=scheduleActivities({acceptScheduled},{clusterId:"test",namespace:"default",activityQueue:"accept"});
  await expect(activities.acceptScheduleTick({...tick,namespace:"other"})).rejects.toThrow("scope mismatch");
  expect(acceptScheduled).not.toHaveBeenCalled();
});
