// A loopback-only, non-CAPTCHA fixture. Browser control is exclusively local Codex CUA.
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,open} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {runCodexWithActionConfirm} from './codex-action-confirm.mjs';
import {CUA_MODEL,CUA_EFFORT,cuaCodexArgs} from './cua-model.mjs';
import {summarizePointerEvidence} from './pointer-evidence.mjs';

assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
assert.equal(process.argv.length,2);
const holdThresholdMs=10000;
const processes=execFileSync('/bin/ps',['-axo','command='],{encoding:'utf8'}).split('\n');
assert.ok(!processes.some(p=>p.startsWith('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ')),'EXISTING_CHROME_DO_NOT_TAKE_OVER');
const root=await mkdtemp('/Users/barry/apps/crawlv3-pointer-lab.');
const route='/'+randomUUID()+'/';
const html=await readFile(new URL('./cua-pointer-lab.html',import.meta.url));
let evidence={down:false,strokes:[],events:[]},origin;
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'&&req.url===route){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  if(req.method==='POST'&&req.url===route+'events'&&req.headers.origin===origin){
    try{let raw='';for await(const c of req){raw+=c;if(raw.length>50000)throw Error('LARGE');}evidence=JSON.parse(raw);res.writeHead(204).end();}
    catch{res.writeHead(400).end();}return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
origin=`http://127.0.0.1:${server.address().port}`;
const url=origin+route;
const chromeLog=await open(`${root}/chrome.log`,'wx',0o600);
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [`--user-data-dir=${root}/profile`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--window-size=1100,850',url],
  {stdio:['ignore',chromeLog.fd,chromeLog.fd]});
const spawned=new Promise((resolve,reject)=>{chrome.once('spawn',resolve);chrome.once('error',reject);});
await chromeLog.close();
await spawned;
const exited=new Promise(resolve=>chrome.once('exit',(code,signal)=>resolve({code,signal})));
console.log(JSON.stringify({event:'POINTER_LAB_STARTED',root,url,chromePid:chrome.pid,model:CUA_MODEL,effort:CUA_EFFORT}));
let result;
try{
  const prompt=`请测试本机鼠标按住动作，不是验证码测试。用户明确要求 Computer Use 使用 Astra low，优先复核以前按钮内短拖动的行为。这是我们自己创建的本机指针测量网页，标题“CUA Pointer Lab”，地址 ${url}，Chrome PID ${chrome.pid}；其他网站/应用/现有任务都不在本轮范围。
只能通过本机 cua_repl 操作浏览器。第一条调用只能 var app = await cua.getApp("com.google.Chrome"); 阅读返回的公开 API 和初始状态，确认上述本机网页。依据新截图定位绿色测试区域，不照搬历史坐标。
本轮核心要求：在绿色测试区域按下鼠标左键后，连续保持至少10秒（10000ms），然后松开；不是点击后等待10秒，不是多次点击，也不是把多次短拖动累计为10秒。请优先尝试完成这一次真正的长按，并用页面事件记录验证。
先读取工具文档，使用文档支持的原生CUA方式完成上述10秒长按。若公开API不能表达持续按下，不虚构 mouseDown/mouseUp、duration、hold 参数，也不使用shell、AppleScript、CDP或网页JS合成事件。可以测一次公开 drag(from,to) 的同点/极短距离动作核对真实时长，但这只是能力诊断，不能替代10秒长按；做不到就明确报告不支持，不声称完成。
每次动作后读取页面显示的实际毫秒数，区分 click/短拖动/连续长按。动作后务必核对“当前鼠标：已松开”。如果显示持续按下，只通过公开CUA在页面标明的中性空白区域点击一次释放，再读取状态。最多4次测量，不刷新、不修改页面/数据，不打开GNC或确认网页，不处理任何验证码。遇工具安全提示停止。
报告实际支持的API、每次时长、是否确实连续按住达到${holdThresholdMs}ms、鼠标是否释放。没有达到就如实报告，不把普通click冒充按住。`;
  result=await runCodexWithActionConfirm({prompt,...cuaCodexArgs(root,{ephemeral:true}),timeoutMs:240000,
    logPath:`${root}/events.jsonl`,errPath:`${root}/stderr.log`,onEvent:event=>console.log(JSON.stringify(event))});
}finally{
  chrome.kill('SIGTERM');
  let timer;
  const stopped=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),15000);})]);
  clearTimeout(timer);
  await new Promise(resolve=>server.close(resolve));
  const report={root,url,model:CUA_MODEL,effort:CUA_EFFORT,code:result?.code,status:result?.status,
    last:result?.last,calls:result?.calls,measurement:summarizePointerEvidence(evidence,holdThresholdMs),evidence,
    chromeStopped:stopped!==null,at:new Date().toISOString()};
  await writeFile(`${root}/report.json`,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify(report));
}
