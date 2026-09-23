import {execFileSync} from 'node:child_process';
// OpenSSH/PowerShell stdin can remain open while ReadToEnd waits. Encode the
// complete bounded script in the command instead; never wait for remote stdin EOF.
export function powershellCommand(source){
 const encoded=Buffer.from("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';\n"+source,'utf16le').toString('base64');
 const command='powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+encoded;
 if(command.length>30000)throw Error('RECOVERY.POWERSHELL_COMMAND_LIMIT');
 return command;
}
export function runWindowsPowerShell(sshArgs,source){
 return JSON.parse(execFileSync('/usr/bin/ssh',[...sshArgs,powershellCommand(source)],{encoding:'utf8',timeout:120000,maxBuffer:3000000}));
}
