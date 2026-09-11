import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, stat, mkdir, access } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

async function main() {
  if (process.platform !== 'win32') throw Error('DTC_WINDOWS_ONLY');
  const root = resolve(process.argv[2] || 'D:\\crawlv3-dtc-v2');
  const executable = process.argv[3];
  const codexHome = process.argv[4] || join(homedir(), '.codex');
  if (!executable || !isAbsolute(executable) || !executable.toLowerCase().endsWith('.exe') || !(await stat(executable)).isFile()) throw Error('DTC_NATIVE_CODEX_EXE_REQUIRED');
  if (!isAbsolute(codexHome) || !(await stat(codexHome)).isDirectory()) throw Error('DTC_CODEX_HOME_REQUIRED');
  if (await access(join(root, 'supervisor.lock')).then(() => true, () => false)) throw Error('DTC_EXISTING_NODE_INSPECT_REQUIRED');
  if (await access(join(root, 'node-session.json')).then(() => true, () => false)) throw Error('DTC_EXISTING_NODE_INSPECT_REQUIRED');
  const inputRoot = resolve(process.argv[5] || join(root, 'inputs'));
  const handoff = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'deployment.json'), 'utf8'));
  const { scope, site } = handoff;
  const readLocal = async (name, code) => { try { return JSON.parse(await readFile(join(inputRoot, name), 'utf8')); } catch { throw Error(code); } };
  const put = async (path, value) => { const bytes = JSON.stringify(value, null, 2); try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST' || await readFile(path, 'utf8') !== bytes) throw Error('DTC_LOCAL_CONFIG_EXISTS_CHANGED'); } };
  const runtime = await readLocal('runtime.private.json', 'DTC_LOCAL_TEMPORAL_CONFIG_MISSING');
  const source = await readLocal('channel.private.json', 'DTC_LOCAL_R2_CONFIG_MISSING');
  if (!source.r2 || !source.r2Credentials) throw Error('DTC_LOCAL_R2_CONFIG_MISSING');
  const browserBase = { ...handoff.channelDefaults, r2: { ...source.r2, prefix: handoff.evidencePrefix }, r2Credentials: source.r2Credentials };
  if (runtime.transport?.mode !== 'mtls') throw Error('DTC_LOCAL_MTLS_CONFIG_REQUIRED');
  for (const [field, name] of [['caFile', 'ca.pem'], ['certFile', 'worker.pem'], ['keyFile', 'worker-key.pem']]) {
    const existing = runtime.transport[field];
    const path = typeof existing === 'string' && isAbsolute(existing) && await access(existing).then(() => true, () => false) ? existing : join(inputRoot, 'certs', name);
    if (!await stat(path).then(s => s.isFile(), () => false)) throw Error('DTC_LOCAL_MTLS_FILE_MISSING');
    runtime.transport[field] = path;
  }
  const files = (await readdir(join(root, 'release'))).filter(n => n.endsWith('.js')).sort();
  async function hash(names) { const h = createHash('sha256'); for (const n of names) { const b = await readFile(join(root, 'release', n)); h.update(String(b.length)); h.update(':'); h.update(b); } return h.digest('hex'); }
  const activityBuild = await hash(files), workflowBuild = await hash([...files, 'product-workflows.cjs'].sort());
  if (activityBuild !== handoff.activityBuild || workflowBuild !== handoff.workflowBuild) {
    const workflow = await readFile(join(root, 'release/product-workflows.cjs'), 'utf8');
    const executable = workflow.split('//# sourceMappingURL=data:application/json;charset=utf-8;base64,')[0];
    console.error(JSON.stringify({ event: 'DTC_RELEASE_BUILD_MISMATCH', activityBuild, workflowBuild, expectedActivityBuild: handoff.activityBuild, expectedWorkflowBuild: handoff.workflowBuild,
      workflowExecutableSha256: createHash('sha256').update(executable).digest('hex'), expectedWorkflowExecutableSha256: handoff.workflowExecutableSha256 }));
    throw Error('DTC_RELEASE_BUILD_MISMATCH');
  }
  const r = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw Error('DTC_CDP_UNAVAILABLE');
  const version = await r.json(), ws = new URL(version.webSocketDebuggerUrl);
  if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(ws.hostname) || ws.port !== '9222') throw Error('DTC_CDP_MUST_BE_LOOPBACK');
  const instanceId = ws.pathname.match(/^\/devtools\/browser\/([A-Za-z0-9-]+)$/)?.[1];
  if (!instanceId) throw Error('DTC_CDP_INSTANCE_INVALID');
  let servers;
  try { servers = JSON.parse(execFileSync(executable, ['mcp', 'list', '--json'], { env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })); }
  catch { throw Error('DTC_MCP_INVENTORY_FAILED'); }
  if (!Array.isArray(servers) || servers.some(s => typeof s.name !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(s.name))) throw Error('DTC_MCP_INVENTORY_INVALID');
  const codex = { settings: { provider: 'openai', model: 'gpt-5.6-luna', reasoningEffort: 'medium' }, executable, codexHome, workRoot: join(root, 'browser-model'), runtimeProfileVersion: 'gnc-persistent-auth/1', timeoutMs: 240000, disabledMcpServers: [...new Set(servers.map(s => s.name))].sort() };
  await mkdir(join(root, 'inputs'), { recursive: true });
  const runtimePath = join(root, 'inputs/runtime.local.json'), channelPath = join(root, 'inputs/channel.browser.json');
  await put(runtimePath, runtime);
  await put(channelPath, browserBase);
  const settings = { target: 'windows', root, queueScope: handoff.queueScope, baseRuntime: runtimePath, baseLive: channelPath, scope, site,
    browser: { endpoint: 'http://127.0.0.1:9222/', instanceId, pauseFile: join(root, 'USER-CONTROL') }, browserResource: handoff.browserResource, browserModelResource: handoff.browserModelResource, codex, evidencePrefix: handoff.evidencePrefix };
  await mkdir(join(root, 'private'), { recursive: true });
  const path = join(root, 'settings.private.json'), bytes = JSON.stringify(settings, null, 2);
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST' || await readFile(path, 'utf8') !== bytes) throw Error('DTC_SETTINGS_EXISTS_CHANGED'); }
  console.log(JSON.stringify({ event: 'DTC_WINDOWS_SETTINGS_PREPARED', settings: path, browserInstanceId: instanceId, disabledMcpCount: codex.disabledMcpServers.length, workflowsSubmitted: 0 }));
}
main().catch(e => { console.error(/^DTC_[A-Z_]+$/.test(e.message) ? e.message : 'DTC_WINDOWS_SETTINGS_FAILED'); process.exitCode = 1; });
