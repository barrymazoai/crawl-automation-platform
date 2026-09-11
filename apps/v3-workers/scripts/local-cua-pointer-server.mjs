// Local, non-CAPTCHA pointer fixture. No browser control or synthetic input here.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {summarizePointerEvidence} from './pointer-evidence.mjs';

const html=await readFile(new URL('./cua-pointer-lab.html',import.meta.url));
const route=`/${randomUUID()}/`;
let origin,evidence={down:false,strokes:[],events:[]};
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'&&req.url===route){
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;
  }
  if(req.method==='GET'&&req.url===route+'evidence'){
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({measurement:summarizePointerEvidence(evidence,10000),evidence}));return;
  }
  if(req.method==='POST'&&req.url===route+'events'&&req.headers.origin===origin){
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>50000)throw Error('LARGE');}
      const next=JSON.parse(raw);
      if(typeof next.down!=='boolean'||!Array.isArray(next.strokes)||!Array.isArray(next.events))throw Error('INVALID');
      evidence=next;res.writeHead(204).end();
      console.log(JSON.stringify({measurement:summarizePointerEvidence(evidence,10000)}));
    }catch{res.writeHead(400).end();}return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
origin=`http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({url:origin+route,evidenceUrl:origin+route+'evidence',pid:process.pid}));
// Keep the page available briefly for the user, then stop the owned server.
const expiry=setTimeout(()=>server.close(),30*60*1000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearTimeout(expiry);server.close();});
