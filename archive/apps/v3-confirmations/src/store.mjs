import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';

export class Fault extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}
const fields = ['workerId', 'taskId', 'threadId', 'url', 'action', 'question', 'contextId'];
export function binding(input) {
  const data = {};
  for (const key of fields) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > (key === 'question' ? 8000 : 2000)) throw new Fault('INVALID_' + key);
    data[key] = input[key];
  }
  let url;
  try { url = new URL(data.url); } catch { throw new Fault('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Fault('HTTPS_URL_REQUIRED');
  return {data, hash: createHash('sha256').update(JSON.stringify(data)).digest('hex')};
}

export class ApprovalStore {
  constructor(path, now = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, hash TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, decided_at INTEGER, reply TEXT, consumed_at INTEGER
      );`);
  }
  close() { this.db.close(); }
  expire() {
    this.db.prepare("UPDATE approvals SET status='expired' WHERE status IN ('pending','approved') AND expires_at<=?").run(this.now());
  }
  record(row) {
    if (!row) throw new Fault('NOT_FOUND', 404);
    return {id: row.id, requestKey: row.request_key, hash: row.hash, ...JSON.parse(row.payload),
      status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
      decidedAt: row.decided_at, reply: row.reply, consumedAt: row.consumed_at};
  }
  create(input) {
    const {data, hash} = binding(input);
    if (!/^[a-zA-Z0-9_-]{10,120}$/.test(input.requestKey ?? '')) throw new Fault('INVALID_REQUEST_KEY');
    const ttl = input.ttlMs ?? 600000;
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 600000) throw new Fault('INVALID_TTL');
    this.expire();
    const previous = this.db.prepare('SELECT * FROM approvals WHERE request_key=?').get(input.requestKey);
    if (previous) {
      if (previous.hash !== hash) throw new Fault('IDEMPOTENCY_CONFLICT', 409);
      return this.record(previous);
    }
    const now = this.now(), id = randomUUID();
    this.db.prepare('INSERT INTO approvals (id,request_key,hash,payload,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.requestKey, hash, JSON.stringify(data), 'pending', now, now + ttl);
    return this.get(id);
  }
  get(id) {
    this.expire();
    return this.record(this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id));
  }
  list() {
    this.expire();
    return this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100').all().map(row => this.record(row));
  }
  decide(id, hash, decision, reply) {
    if (!['approved', 'rejected'].includes(decision)) throw new Fault('INVALID_DECISION');
    if (typeof reply !== 'string' || !reply.trim() || reply.length > 2000) throw new Fault('REPLY_REQUIRED');
    this.expire();
    const changed = this.db.prepare("UPDATE approvals SET status=?,reply=?,decided_at=? WHERE id=? AND hash=? AND status='pending' AND expires_at>?")
      .run(decision, reply, this.now(), id, hash, this.now());
    if (!changed.changes) throw new Fault('NOT_PENDING_OR_BINDING_CHANGED', 409);
    return this.get(id);
  }
  consume(id, hash) {
    this.expire();
    const row = this.db.prepare("UPDATE approvals SET status='consumed',consumed_at=? WHERE id=? AND hash=? AND status='approved' AND expires_at>? RETURNING *")
      .get(this.now(), id, hash, this.now());
    if (!row) throw new Fault('NOT_APPROVED_OR_ALREADY_CONSUMED', 409);
    return this.record(row);
  }
}
