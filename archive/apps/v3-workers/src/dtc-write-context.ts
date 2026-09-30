import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const errorCode=(e:unknown)=>typeof (e as NodeJS.ErrnoException)?.code==='string'?(e as NodeJS.ErrnoException).code:'UNKNOWN';
const inside=(root:string,path:string)=>{const r=relative(root,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..\\')&&!r.startsWith('../'));};
/** Read-only context. It neither creates a probe nor changes ACLs or sandbox settings. */
export async function dtcWriteContext(rawRoot:string,rawTarget:string){
 const root=resolve(rawRoot),target=resolve(root,rawTarget);
 if(!inside(root,target))throw Error('DTC.DIAGNOSTIC_PATH_OUTSIDE_TASK');
 const paths=[root];let p=target;
 const ancestors:string[]=[];while(p!==root){ancestors.unshift(p);const next=dirname(p);if(next===p)throw Error('DTC.DIAGNOSTIC_PATH_OUTSIDE_TASK');p=next;}paths.push(...ancestors);
 const entries:Record<string,unknown>[]=[];
 let boundary=false,canonicalRoot=root;
 for(const path of paths){
  if(boundary){entries.push({path,status:'not_inspected_after_path_boundary'});continue;}
  try{const s=await lstat(path);if(s.isSymbolicLink()){entries.push({path,status:'symlink_not_followed'});boundary=true;continue;}
   const canonical=await realpath(path);if(path===root)canonicalRoot=canonical;if(!inside(canonicalRoot,canonical)){entries.push({path,status:'canonical_path_outside_task'});boundary=true;continue;}
   entries.push({path,status:'exists',directory:s.isDirectory(),file:s.isFile(),bytes:s.size,mode:s.mode.toString(8),canonical});
  }catch(e){entries.push({path,status:errorCode(e)});boundary=true;}
 }
 let windows:unknown=null;
 if(process.platform==='win32'){
  // Fixed script; paths are data in the environment, never interpolated into shell code.
  const script=`$ErrorActionPreference='Stop'; $rows=@(); foreach($p in ($env:DTC_DIAGNOSTIC_PATHS | ConvertFrom-Json)){try{$a=Get-Acl -LiteralPath $p; $rows+=@{path=$p;owner=$a.Owner;inheritanceProtected=$a.AreAccessRulesProtected;access=@($a.Access | ForEach-Object {@{identity=$_.IdentityReference.Value;rights=$_.FileSystemRights.ToString();type=$_.AccessControlType.ToString();inherited=$_.IsInherited;inheritance=$_.InheritanceFlags.ToString();propagation=$_.PropagationFlags.ToString()}})}}catch{$rows+=@{path=$p;error=$_.Exception.GetType().Name;hresult=$_.Exception.HResult}}}; @{identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name;acl=$rows} | ConvertTo-Json -Depth 6 -Compress`;
  const env:NodeJS.ProcessEnv={};for(const name of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','USERPROFILE','TEMP','TMP'])if(process.env[name]!==undefined)env[name]=process.env[name];
  env.DTC_DIAGNOSTIC_PATHS=JSON.stringify(entries.filter(e=>e.status==='exists').map(e=>e.path));
  try{const r=await promisify(execFile)(resolve(process.env.SystemRoot??process.env.SYSTEMROOT??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true,timeout:5000,maxBuffer:256*1024});windows=JSON.parse(r.stdout.replace(/^\uFEFF/,''));}
  catch(e){windows={inspectionError:errorCode(e),message:'Read-only identity/ACL inspection unavailable; no permission change attempted'};}
 }
 return{event:'DTC_WRITE_CONTEXT',at:new Date().toISOString(),pid:process.pid,platform:process.platform,cwd:process.cwd(),root,target,entries,windows,permissionConclusion:'Metadata only; host success does not prove sandbox write access'};
}
if(basename(process.argv[1]??'')==='dtc-write-context.js'){
 dtcWriteContext(process.argv[2]??'',process.argv[3]??'').then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('DTC_WRITE_CONTEXT_UNAVAILABLE');process.exitCode=1;});
}
