import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
// Windows' OpenSSH default shell rejects long command lines. Keep the loader
// small and read exactly the announced UTF-8 byte count, not stdin until EOF.
export function powershellCommand(source){
 const length=Buffer.byteLength(source,'utf8');
 if(length<1||length>128*1024)throw Error('RECOVERY.POWERSHELL_SCRIPT_LIMIT');
 const loader=`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$stream=[Console]::OpenStandardInput();$bytes=New-Object byte[] ${length};$offset=0;while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'RECOVERY.SCRIPT_TRUNCATED'};$offset+=$n};& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes)))`;
 const encoded=Buffer.from(loader,'utf16le').toString('base64');
 const command='powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+encoded;
 if(command.length>4000)throw Error('RECOVERY.POWERSHELL_COMMAND_LIMIT');
 return command;
}
export function runWindowsPowerShell(sshArgs,source){
 try{return JSON.parse(execFileSync('/usr/bin/ssh',[...sshArgs,powershellCommand(source)],{input:Buffer.from(source,'utf8'),encoding:'utf8',timeout:120000,maxBuffer:3000000}));}
 catch(error){
  const stderr=String(error.stderr??''),failure=new Error('Windows control command did not complete');
  failure.code=error.code==='ETIMEDOUT'?'RECOVERY.WINDOWS_TRANSPORT_TIMEOUT':/command line is too long/i.test(stderr)?'RECOVERY.WINDOWS_COMMAND_TOO_LONG':'RECOVERY.WINDOWS_COMMAND_FAILED';
  failure.diagnostics={exitStatus:Number.isInteger(error.status)?error.status:null,stderrSha256:createHash('sha256').update(stderr).digest('hex')};
  throw failure;
 }
}
