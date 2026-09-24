import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
// Windows' OpenSSH default shell rejects long command lines. Keep the loader
// small and read exactly the announced UTF-8 byte count, not stdin until EOF.
export function powershellCommand(source){
 const length=Buffer.byteLength(source,'utf8');
 if(length<1||length>128*1024)throw Error('RECOVERY.POWERSHELL_SCRIPT_LIMIT');
 const loader=`[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$stream=[Console]::OpenStandardInput();$bytes=New-Object byte[] ${length};$offset=0;while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'RECOVERY.SCRIPT_TRUNCATED'};$offset+=$n};& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes)))`;
 const encoded=Buffer.from(loader,'utf16le').toString('base64');
 const command='powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+encoded;
 if(command.length>4000)throw Error('RECOVERY.POWERSHELL_COMMAND_LIMIT');
 return command;
}
export function redactControlOutput(text,limit=4000){
 return String(text??'').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']+/g,'$1?[REDACTED_QUERY]')
  .replace(/(password|secret|token|key)(["'\s:=]+)[^\s"',;]+/gi,'$1$2[REDACTED]').slice(0,limit);
}
export function runWindowsPowerShell(sshArgs,source){
 try{return JSON.parse(execFileSync('/usr/bin/ssh',[...sshArgs,powershellCommand(source)],{input:Buffer.from(source,'utf8'),encoding:'utf8',timeout:120000,maxBuffer:3000000}));}
 catch(error){
  const stderr=String(error.stderr??''),failure=new Error('Windows control command did not complete');
  failure.code=error.code==='ETIMEDOUT'?'RECOVERY.WINDOWS_TRANSPORT_TIMEOUT':/command line is too long/i.test(stderr)?'RECOVERY.WINDOWS_COMMAND_TOO_LONG':'RECOVERY.WINDOWS_COMMAND_FAILED';
  // The hash goes into public health; the redacted text only into the private
  // cleanup directory, so the next operator can read which line threw.
  failure.diagnostics={exitStatus:Number.isInteger(error.status)?error.status:null,stderrSha256:createHash('sha256').update(stderr).digest('hex'),stderrText:redactControlOutput(stderr)};
  throw failure;
 }
}
