import {readFile, stat, writeFile, rename} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';

export async function saveReportAtomic(path, report) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  await rename(temporary,path);
}

export async function loadApprovalConfig(path) {
  if (!path) throw new Error('APPROVAL_CONFIG_PATH_REQUIRED');
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error('APPROVAL_CONFIG_MUST_BE_PRIVATE');
  const config = JSON.parse(await readFile(path, 'utf8'));
  const url = new URL(config.origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') throw new Error('APPROVAL_HTTPS_ORIGIN_REQUIRED');
  if (typeof config.workerToken !== 'string' || config.workerToken.length < 32) throw new Error('WORKER_TOKEN_REQUIRED');
  if ('password' in config || 'APPROVAL_PASSWORD' in config) throw new Error('HUMAN_CREDENTIALS_FORBIDDEN_ON_WORKER');
  return {...config, origin: url.origin};
}
export class HumanConfirmationClient {
  constructor(config, fetchFn = fetch) { this.config = config; this.fetchFn = fetchFn; }
  async request(path, body) {
    const response = await this.fetchFn(this.config.origin + path, {method: body ? 'POST' : 'GET',
      redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {Authorization: `Bearer ${this.config.workerToken}`, ...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {})});
    if (!response.ok) throw new Error(`APPROVAL_HTTP_${response.status}`);
    return response.json();
  }
  create(binding) { return this.request('/worker/requests', binding); }
  get(id) { return this.request(`/worker/requests/${encodeURIComponent(id)}`); }
  async consume(id, expected) {
    const record = await this.get(id);
    for (const key of ['hash', 'threadId', 'contextId']) {
      if (record[key] !== expected[key]) throw new Error('APPROVAL_BINDING_MISMATCH');
    }
    if (record.status !== 'approved' || record.expiresAt <= Date.now()) throw new Error('APPROVAL_NOT_CURRENTLY_APPROVED');
    const receipt = await this.request(`/worker/requests/${encodeURIComponent(id)}/consume`, {hash:expected.hash});
    for (const key of ['hash', 'threadId', 'contextId']) {
      if (receipt[key] !== expected[key]) throw new Error('APPROVAL_RECEIPT_MISMATCH');
    }
    if (receipt.status !== 'consumed' || !receipt.reply?.trim() || receipt.expiresAt <= Date.now()) throw new Error('APPROVAL_RECEIPT_INVALID');
    return receipt;
  }
}
export function approvalContext(target) {
  return createHash('sha256').update(JSON.stringify({session:target.lane?.sessionId,
    pid:target.lane?.browserPid, lane:target.lane?.laneId, profile:target.lane?.profilePath,
    startedAt:target.startedAt, url:'https://www.gnc.com/energy/613701.html'})).digest('hex');
}
