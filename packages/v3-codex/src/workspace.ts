import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Only these task-owned disposable directories may be removed by maintenance. */
export async function codexWorkspace(root: string, prefix: 'execution-' | 'vision-') {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(root, prefix));
  await writeFile(join(cwd, '.crawler-owner.json'), JSON.stringify({ codec: 'codex-workspace/1', pid: process.pid }), { flag: 'wx', mode: 0o600 });
  return cwd;
}

/** Call only after the owned RPC process has a verified exit receipt. */
export async function finishCodexWorkspace(cwd: string) {
  try {
    await writeFile(join(cwd, '.crawler-stopped.json'), JSON.stringify({ codec: 'codex-workspace-stopped/1', at: new Date().toISOString() }), { mode: 0o600 });
    await rm(cwd, { recursive: true, force: true });
  } catch { /* A later bounded janitor pass sees the stop receipt or dead owner. */ }
}
