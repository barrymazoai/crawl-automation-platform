import * as fs from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { type ObjectProof } from './contracts.js';

export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, file);
}
export async function readJson(file: string) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function createJson(file: string, value: unknown) {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
export class LocalEvidence {
  constructor(readonly root: string) {}
  private path(key: string) {
    if (!/^[a-zA-Z0-9_/-]+(?:\.[a-z]+)?$/.test(key) || key.split('/').some(p => !p || p === '..' || p === '.') || key.startsWith('/')) throw Error('BRAND_ENTRY.OBJECT_PATH');
    return resolve(this.root, key);
  }
  async read(ref: ObjectProof): Promise<Buffer> {
    const root = await fs.realpath(this.root), file = await fs.realpath(this.path(ref.key));
    if (!file.startsWith(root + sep)) throw Error('BRAND_ENTRY.OBJECT_PATH');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== ref.byteSize || stat.size > 8 * 1024 * 1024) throw Error('BRAND_ENTRY.EVIDENCE_UNVERIFIED');
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== ref.sha256) throw Error('BRAND_ENTRY.EVIDENCE_UNVERIFIED');
    return bytes;
  }
  async retain(key: string, bytes: Uint8Array, mediaType: string): Promise<ObjectProof> {
    const file = this.path(key), proof = { key, sha256: digest(bytes), byteSize: bytes.length, mediaType };
    await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temp, file); } catch (e: any) { if (e.code !== 'EEXIST') throw e; } finally { await fs.rm(temp); }
    await this.read(proof); return proof;
  }
}
