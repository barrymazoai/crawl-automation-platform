/** Local cancellation starts before the server deadline, leaving time to close
 * owned provider processes and retain stop evidence. Never race away from fn:
 * settlement of the real operation, not expiry of a timer, permits release.
 * An uncooperative/crashed worker remains quarantined for exact-executor recovery.
 */
export const executionDeadlineMs = 10 * 60 * 1000;
export async function withActivityDeadline<T>(parent:AbortSignal,fn:(signal:AbortSignal)=>Promise<T>,timeoutMs=executionDeadlineMs):Promise<T>{
  const deadline=new AbortController(),signal=AbortSignal.any([parent,deadline.signal]);
  const timer=setTimeout(()=>deadline.abort(Error("EXECUTION.DEADLINE_EXCEEDED")),timeoutMs);
  try{signal.throwIfAborted();const result=await fn(signal);signal.throwIfAborted();return result;}
  finally{clearTimeout(timer);}
}
