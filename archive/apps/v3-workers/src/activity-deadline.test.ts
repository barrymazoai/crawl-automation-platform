import {afterEach,expect,it,vi} from 'vitest';
import {withActivityDeadline} from './activity-deadline.js';
afterEach(()=>vi.useRealTimers());
it('aborts at the deadline but awaits actual provider closure before settling',async()=>{
 vi.useFakeTimers();let close!:()=>void,settled=false,observed:AbortSignal|undefined;
 const work=withActivityDeadline(new AbortController().signal,async s=>{observed=s;await new Promise<void>(r=>{close=r;});return 'late';},100);
 const verdict=work.then(()=>{settled=true;return 'success';},e=>{settled=true;return e.message;});
 await vi.advanceTimersByTimeAsync(100);expect(observed?.aborted).toBe(true);expect(settled).toBe(false);
 close();expect(await verdict).toBe('EXECUTION.DEADLINE_EXCEEDED');expect(vi.getTimerCount()).toBe(0);
});
it('does not start already-cancelled execution or retry an explicit error',async()=>{
 vi.useFakeTimers();const c=new AbortController(),fn=vi.fn(async()=>{throw Error('provider failed');});
 await expect(withActivityDeadline(c.signal,fn,100)).rejects.toThrow('provider failed');expect(fn).toHaveBeenCalledTimes(1);
 c.abort(Error('cancelled'));await expect(withActivityDeadline(c.signal,fn,100)).rejects.toThrow('cancelled');expect(fn).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});
it('forwards cancellation while preserving successful completion and removing timers',async()=>{
 vi.useFakeTimers();const c=new AbortController();
 expect(await withActivityDeadline(c.signal,async()=>42,100)).toBe(42);expect(vi.getTimerCount()).toBe(0);
 const work=withActivityDeadline(c.signal,s=>new Promise((_,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true})),100);
 const verdict=expect(work).rejects.toThrow('cancelled');c.abort(Error('cancelled'));await verdict;expect(vi.getTimerCount()).toBe(0);
});
