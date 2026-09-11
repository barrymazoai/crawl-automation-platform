import {afterEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('node:fs/promises',()=>({readFile:(...args:unknown[])=>state.read(...args)}));
import {readWorkerReady} from './worker-readiness.js';
afterEach(()=>{vi.useRealTimers();state.read.mockReset();});
it('heartbeat written during asynchronous read is fresh, not in the future',async()=>{
 vi.useFakeTimers();vi.setSystemTime(100000);
 state.read.mockImplementation(async()=>{await Promise.resolve();vi.setSystemTime(100020);return JSON.stringify({pid:7,event:'WORKER_RUNNING',reportedAt:new Date(100010).toISOString()});});
 expect(await readWorkerReady('/private/health',7)).toBe(true);
});
it.each(['stale','future','pid','stopped','broken'])('still rejects %s evidence',async mode=>{
 vi.useFakeTimers();vi.setSystemTime(100000);
 state.read.mockResolvedValue(mode==='broken'?'':JSON.stringify({pid:mode==='pid'?8:7,event:mode==='stopped'?'WORKER_STOPPED':'WORKER_RUNNING',reportedAt:new Date(mode==='stale'?85000:mode==='future'?100001:100000).toISOString()}));
 expect(await readWorkerReady('/private/health',7)).toBe(false);
});
