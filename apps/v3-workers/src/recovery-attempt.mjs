import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

export function recoveryError(error,depth=0){
 const token=v=>typeof v==='string'&&/^[A-Z_a-z0-9.:-]{1,100}$/.test(v)?v:undefined;
 return {code:token(error?.code)??token(error?.name)??'Error',
  ...(Number.isInteger(error?.diagnostics?.exitStatus)?{exitStatus:error.diagnostics.exitStatus}:{}),
  ...(/^[a-f0-9]{64}$/.test(error?.diagnostics?.stderrSha256??'')?{stderrSha256:error.diagnostics.stderrSha256}:{}),
  ...(depth<2&&Array.isArray(error?.errors)?{causes:error.errors.slice(0,4).map(e=>recoveryError(e,depth+1))}:{})};
}

export const claimPath=(out,permitId)=>out+'/recovery-attempts/'+createHash('sha256').update(permitId).digest('hex')+'.json';

// A claim survives process exit. Failure, timeout, lost acknowledgement and a
// crashed monitor all require manual reconciliation, never another stop/start.
export async function recoverOnce({out,permits,run}){
 const dir=out+'/recovery-attempts';fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const paths=[...new Set(permits.map(p=>p.request.permitId))].sort().map(id=>claimPath(out,id));
 if(!paths.length)throw Error('RECOVERY.EMPTY');
 const prior=paths.filter(p=>fs.existsSync(p)).map(p=>JSON.parse(fs.readFileSync(p)));
 if(prior.length)return {status:'blocked',reason:'RECOVERY.MANUAL_RECONCILIATION',attempts:prior};
 const attempt={id:randomUUID(),at:new Date().toISOString(),status:'started',permits:permits.map(p=>p.request.permitId)};
 const owned=[];
 for(const path of paths){
  try{const fd=fs.openSync(path,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(attempt));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}owned.push(path);}
  catch(e){if(e.code==='EEXIST')return {status:'blocked',reason:'RECOVERY.CONCURRENT_CLAIM',attempts:[attempt]};throw e;}
 }
 const save=value=>{for(const path of owned){fs.writeFileSync(path+'.'+attempt.id,JSON.stringify(value),{mode:0o600});fs.renameSync(path+'.'+attempt.id,path);}};
 try{
  const result=await run(attempt.id);save({...attempt,status:'completed',finishedAt:new Date().toISOString()});
  return {status:'completed',result};
 }catch(error){
  // Do not store arbitrary stderr, URLs or credentials in public queue health.
  const token=v=>typeof v==='string'&&/^[A-Z_a-z0-9.:-]{1,100}$/.test(v)?v:undefined;
  const failed={...attempt,status:'failed',finishedAt:new Date().toISOString(),error:token(error.code)??token(error.name)??'Error',diagnostics:recoveryError(error)};
  save(failed);return {status:'blocked',reason:'RECOVERY.MANUAL_RECONCILIATION',attempts:[failed]};
 }
}

// The explicit operator step behind CLEANUP_FAILED_MANUAL_REQUIRED. It runs the
// same exact-executor cleanup once more under a new attempt id, only when every
// permit already carries a failed claim (the monitor's one automatic try), and
// records the outcome on those claims. Nothing here retries a business task.
export async function reconcileOnce({out,permits,run}){
 const ids=[...new Set(permits.map(p=>p.request.permitId))].sort(),paths=ids.map(id=>claimPath(out,id));
 if(!paths.length)throw Error('RECOVERY.EMPTY');
 const prior=paths.map(p=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):null);
 const missing=ids.filter((_,i)=>!prior[i]),active=prior.filter(c=>c&&!['failed','reconciled'].includes(c.status));
 if(missing.length)return {status:'refused',reason:'RECOVERY.NO_FAILED_CLAIM',permits:missing};
 if(active.length)return {status:'refused',reason:'RECOVERY.CLAIM_ACTIVE',attempts:active};
 const attempt={id:randomUUID(),at:new Date().toISOString(),status:'reconciling',permits:ids,previous:prior.map(c=>({id:c.id,status:c.status,error:c.error}))};
 const save=value=>{for(const path of paths){fs.writeFileSync(path+'.'+attempt.id,JSON.stringify(value),{mode:0o600});fs.renameSync(path+'.'+attempt.id,path);}};
 save(attempt);
 try{const result=await run(attempt.id);save({...attempt,status:'reconciled',finishedAt:new Date().toISOString()});return {status:'reconciled',attemptId:attempt.id,result};}
 catch(error){const failed={...attempt,status:'failed',finishedAt:new Date().toISOString(),error:recoveryError(error).code,diagnostics:recoveryError(error)};save(failed);return {status:'failed',attemptId:attempt.id,attempt:failed};}
}
