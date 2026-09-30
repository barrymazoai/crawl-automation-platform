import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';

function text(value:string){
 return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]')
  .replace(/\bBearer\s+[^\s,;]+/gi,'Bearer [redacted]')
  .replace(/((?:access[_-]?token|api[_-]?key|secret[_-]?access[_-]?key|password)\s*[=:]\s*)[^\s,;]+/gi,'$1[redacted]')
  .replace(/https?:\/\/[^\s"'<>]+/g,raw=>{try{const u=new URL(raw);u.username='';u.password='';u.search='';u.hash='';return u.href;}catch{return '[redacted URL]';}});
}
/** Keep the exception chain, not arbitrary SDK metadata or private configuration. */
export function dtcNodeError(value:unknown,seen=new Set<unknown>(),depth=0):unknown{
 if(depth>=5||seen.has(value))return {name:'CauseLimit'};
 if(!value||typeof value!=='object')return {message:text(String(value)).slice(0,2000)};
 seen.add(value);const e=value as {name?:unknown;message?:unknown;stack?:unknown;code?:unknown;details?:unknown;cause?:unknown};
 return {name:typeof e.name==='string'?text(e.name):'Error',
  ...(typeof e.message==='string'?{message:text(e.message).slice(0,4000)}:{}),
  ...(typeof e.code==='number'||typeof e.code==='string'?{code:typeof e.code==='string'?text(e.code):e.code}:{}),
  ...(typeof e.details==='string'?{details:text(e.details).slice(0,4000)}:{}),
  ...(typeof e.stack==='string'?{stack:text(e.stack).slice(0,8000)}:{}),
  ...(e.cause!==undefined?{cause:dtcNodeError(e.cause,seen,depth+1)}:{})};
}
export type DtcNodeLog=(event:Record<string,unknown>)=>Promise<void>;
export function dtcNodeLogger(root:string):DtcNodeLog{
 let pending=Promise.resolve();
 return event=>{
  const line=JSON.stringify({at:new Date().toISOString(),pid:process.pid,...event})+'\n';
  pending=pending.then(()=>appendFile(join(root,'node-events.jsonl'),line,{mode:0o600})).catch(error=>{
   process.stderr.write(line);process.stderr.write(JSON.stringify({at:new Date().toISOString(),event:'DTC_NODE_LOG_WRITE_FAILED',error:dtcNodeError(error)})+'\n');
  });return pending;
 };
}
