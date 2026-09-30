import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalEvidence, createJson, digest } from './local-store.js';

describe('standalone immutable evidence', () => {
  it('preserves original BOM bytes and refuses to replace a different existing object', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'brand-evidence-'));
    try {
      const store = new LocalEvidence(root), body = Buffer.from('\ufeff<!doctype html><p>品牌</p>');
      const proof = await store.retain('v3/brand-entry/seed/original.html', body, 'text/html');
      expect(await store.read(proof)).toEqual(body);
      expect((await store.retain(proof.key, body, 'text/html')).sha256).toBe(digest(body));
      await expect(store.retain(proof.key, Buffer.from('replacement'), 'text/html')).rejects.toThrow('EVIDENCE_UNVERIFIED');
      expect(await store.read(proof)).toEqual(body);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('rejects corruption and directory traversal when importing transferred results', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'brand-evidence-'));
    try {
      const store = new LocalEvidence(root), proof = await store.retain('one.html', Buffer.from('abc'), 'text/html');
      await expect(store.read({ ...proof, key: '../outside.html' })).rejects.toThrow('OBJECT_PATH');
      await fs.writeFile(join(root, 'one.html'), 'xyz');
      await expect(store.read(proof)).rejects.toThrow('EVIDENCE_UNVERIFIED');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('persists a start marker exactly once so restart cannot repeat a business attempt', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'brand-evidence-'));
    try {
      const file = join(root, 'attempt.json'); await createJson(file, { started: true });
      await expect(createJson(file, { started: true })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ started: true });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
