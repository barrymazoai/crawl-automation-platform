// Atomic status publication for the Windows cloud supervisor.
// Windows refuses to rename over a file that another process currently holds
// open (PowerShell's Get-Content from the Server 1 health probe, an operator's
// editor, an antivirus scan). That surfaced as EPERM from renameSync and, when
// unhandled inside the status timer, took the supervisor and both model Workers
// down three times on 2026-09-23. The replace is retried briefly; a persistent
// failure is reported to the caller as a deferred publication, never thrown.
export const RETRYABLE=new Set(['EPERM','EBUSY','EACCES','ENOTEMPTY']);
export function replaceFileWithRetry(io,temporary,target,{attempts=12,sleepMs=25}={}){
 let last;
 for(let n=0;n<attempts;n++){
  try{io.renameSync(temporary,target);return {replaced:true,attempts:n+1};}
  catch(error){last=error;if(!RETRYABLE.has(error?.code))throw error;io.sleepSync(sleepMs);}
 }
 // The temporary file stays in place: the next publication overwrites the same
 // name, so nothing accumulates and no delete is issued from the timer.
 return {replaced:false,attempts,code:last?.code??'unknown'};
}
export function sleepSync(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}
