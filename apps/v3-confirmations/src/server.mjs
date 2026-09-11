import {createServer} from 'node:http';
import {timingSafeEqual, createHmac} from 'node:crypto';
import {readFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ApprovalStore, Fault} from './store.mjs';

function equal(a, b) {
  const x = Buffer.from(a ?? ''), y = Buffer.from(b ?? '');
  return x.length === y.length && timingSafeEqual(x, y);
}
async function jsonBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw new Fault('JSON_REQUIRED', 415);
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 20000) throw new Fault('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { const data = JSON.parse(raw); if (!data || typeof data !== 'object' || Array.isArray(data)) throw 0; return data; }
  catch { throw new Fault('INVALID_JSON'); }
}

export function approvalServer({store, workerToken, username, password, origin}) {
  if (workerToken?.length < 32 || password?.length < 24 || !username || !workerToken || !password || equal(workerToken, password)) throw new Error('SEPARATE_STRONG_CREDENTIALS_REQUIRED');
  const allowedOrigin = new URL(origin).origin;
  if (!origin.startsWith('https://') && !/^http:\/\/127\.0\.0\.1(?::|$)/.test(origin)) throw new Error('HTTPS_REQUIRED');
  const basic = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const csrf = record => createHmac('sha256', password).update(record.id + ':' + record.hash).digest('hex');
  const html = readFileSync(new URL('./index.html', import.meta.url));
  const js = readFileSync(new URL('./ui.js', import.meta.url));
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, {'Content-Type': type});
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      const path = new URL(req.url, allowedOrigin).pathname;
      if (path === '/healthz' && req.method === 'GET') { store.db.prepare('SELECT 1').get(); return send(200, {ok: true}); }
      const workerRoute = path.startsWith('/worker/');
      if (workerRoute ? !equal(req.headers.authorization, `Bearer ${workerToken}`) : !equal(req.headers.authorization, basic)) {
        if (!workerRoute) res.setHeader('WWW-Authenticate', 'Basic realm="Crawler confirmations", charset="UTF-8"');
        return send(401, {error: 'UNAUTHORIZED'});
      }
      if (req.method === 'GET' && path === '/') return send(200, html, 'text/html; charset=utf-8');
      if (req.method === 'GET' && path === '/ui.js') return send(200, js, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && path === '/human/requests') return send(200, {items: store.list().map(row => ({...row, csrf: csrf(row)}))});
      if (req.method === 'POST' && path === '/worker/requests') return send(201, store.create(await jsonBody(req)));
      const match = path.match(/^\/(worker|human)\/requests\/([a-f0-9-]{36})(?:\/(consume|decision))?$/);
      if (!match) throw new Fault('NOT_FOUND', 404);
      const [, role, id, action] = match;
      if (req.method === 'GET' && role === 'worker' && !action) return send(200, store.get(id));
      if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
      if (role === 'human' && action === 'decision') {
        if (req.headers.origin !== allowedOrigin) throw new Fault('ORIGIN_REJECTED', 403);
        const row = store.get(id);
        if (!equal(req.headers['x-csrf-token'], csrf(row))) throw new Fault('CSRF_REJECTED', 403);
        const input = await jsonBody(req);
        return send(200, store.decide(id, input.hash, input.decision, input.reply));
      }
      if (role === 'worker' && action === 'consume') {
        const input = await jsonBody(req);
        return send(200, store.consume(id, input.hash));
      }
      throw new Fault('NOT_FOUND', 404);
    } catch (err) {
      send(err instanceof Fault ? err.status : 500, {error: err instanceof Fault ? err.message : 'INTERNAL_ERROR'});
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.APPROVAL_DB ?? '/data/approvals.sqlite';
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const store = new ApprovalStore(path);
  const server = approvalServer({store, workerToken: process.env.APPROVAL_WORKER_TOKEN,
    username: process.env.APPROVAL_USERNAME, password: process.env.APPROVAL_PASSWORD,
    origin: process.env.APPROVAL_ORIGIN});
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log('Confirmation service listening'));
  const stop = () => server.close(() => { store.close(); process.exit(0); });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
