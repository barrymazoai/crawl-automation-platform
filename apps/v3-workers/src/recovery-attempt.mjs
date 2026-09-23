import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

// A claim survives process exit. Failure, timeout, lost acknowledgement and a
// crashed monitor all require manual reconciliation, never another stop/start.
export async function recoverOnce({out,permits,run}){
 const dir=out+'/recovery-attempts';fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const paths=[...new Set(permits.map(p=>p.request.permitId))].sort().map(id=>dir+'/'+createHash('sha256').update(id).digest('hex')+'.json');
 if(!paths.length)throw Error('RECOVERY.EMPTY');
 const prior=paths.filter(p=>fs.existsSync(p)).map(p=>JSON.parse(fs.readFileSync(p)));
 if(prior.length)return {status:'blocked',reason:'RECOVERY.MANUAL_RECONCILIATION',attempts:prior};
 const attempt={id:randomUUID(),at:new Date().toISOString(),status:'started',permits:permits.map(p=>p.request.permitId)};
 const owned=[];
 for(const path of paths){
  try{fs.writeFileSync(path,JSON.stringify(attempt),{flag:'wx',mode:0o600});owned.push(path);}
  catch(e){if(e.code==='EEXIST')return {status:'blocked',reason:'RECOVERY.CONCURRENT_CLAIM',attempts:[attempt]};throw e;}
 }
 const save=value=>{for(const path of owned){fs.writeFileSync(path+'.'+attempt.id,JSON.stringify(value),{mode:0o600});fs.renameSync(path+'.'+attempt.id,path);}};
 try{
  const result=await run(attempt.id);save({...attempt,status:'completed',finishedAt:new Date().toISOString()});
  return {status:'completed',result};
 }catch(error){
  // Do not store arbitrary stderr, URLs or credentials in public queue health.
  const token=v=>typeof v==='string'&&/^[A-Z_a-z0-9.:-]{1,100}$/.test(v)?v:undefined;
  const failed={...attempt,status:'failed',finishedAt:new Date().toISOString(),error:token(error.code)??token(error.name)??'Error'};
  save(failed);return {status:'blocked',reason:'RECOVERY.MANUAL_RECONCILIATION',attempts:[failed]};
 }
}
