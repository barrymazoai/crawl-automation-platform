// Exercises the calls LoopbackCdp/CdpTaskPages make: version guard, /json/new with marker,
// Target.getTargets over the browser socket, a page-socket call, /json/close and absence check.
const ep = process.argv[2];
const rpc = (path, method, params = {}) => new Promise((res, rej) => { const ws = new WebSocket(ep.replace('http:', 'ws:').replace(/\/$/, '') + path); ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params })); ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== 1) return; ws.close(); m.error ? rej(Error(JSON.stringify(m.error))) : res(m.result); }; ws.onerror = () => rej(Error('ws error')); });
const v = await (await fetch(new URL('/json/version', ep))).json(); console.log('version', v.webSocketDebuggerUrl);
const inst = v.webSocketDebuggerUrl.split('/').pop();
const marker = `about:blank#crawlv3-${crypto.randomUUID()}`;
const created = await (await fetch(new URL('/json/new?' + encodeURIComponent(marker), ep), { method: 'PUT' })).json(); console.log('created', created.id, created.url === marker);
const list = async () => (await rpc('/devtools/browser/' + inst, 'Target.getTargets')).targetInfos;
console.log('listed', (await list()).map(t => [t.targetId.slice(0, 8), t.type, t.url.slice(0, 60)]));
console.log('nav', await rpc('/devtools/page/' + created.id, 'Page.navigate', { url: 'https://shop.hmwmethod.com/collections/all' }));
await new Promise(r => setTimeout(r, 4000));
console.log('eval', (await rpc('/devtools/page/' + created.id, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value);
console.log('close', await (await fetch(new URL('/json/close/' + created.id, ep))).text());
for (let n = 0; n < 30; n++) { if (!(await list()).some(t => t.targetId === created.id)) { console.log('absent after', n * 100, 'ms'); process.exit(0); } await new Promise(r => setTimeout(r, 100)); }
console.log('STILL PRESENT'); process.exit(1);
