// Local deployment wrapper for the Windows Text/Vision model Workers.
// Does not modify bundled Worker code or submit tasks. Manually started; no
// boot/login installation. Deployed as D:\crawlv3-cloud\cloud-supervisor.mjs
// together with status-file.mjs; the activation script rebinds `release`.
//
// 2026-09-24: the supervisor previously died whenever its 5-second status
// rename collided with a reader holding cloud-status.json open (EPERM on
// Windows). The crash was unobserved, left a stale "running" status and broke
// the Workers' stdout pipes so they exited too. Every exit path now records an
// event, status writes retry and never throw, a stale lock from a dead owner is
// taken over with proof, and the process survives its own unexpected errors.
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { replaceFileWithRetry, sleepSync } from './status-file.mjs';

const root = 'D:/crawlv3-cloud';
const release = path.join(root, 'releases/local-temporal-20260923/source/apps/v3-workers/dist/cloud-workers');
const control = path.join(root, 'private');
const lockPath = path.join(control, 'cloud-supervisor.lock');
const stopPath = path.join(control, 'STOP-cloud');
const statusPath = path.join(control, 'cloud-status.json');
const roles = ['text', 'vision']; // OCR tasks run on the US Mac mini; Windows provides OCR HTTP only.
const sessionId = randomUUID();
const startedAt = new Date().toISOString();
const logDir = process.argv[2];
if (!logDir || !path.isAbsolute(logDir) || !fs.statSync(logDir).isDirectory()) throw Error('LOG_DIRECTORY_REQUIRED');
if (fs.existsSync(stopPath)) throw Error('STOP_PRESENT');
const state = new Map();
const secrets = [];
for (const role of roles) {
  const c = JSON.parse(fs.readFileSync(path.join(control, `channel-label-${role}.private.json`), 'utf8'));
  secrets.push(...Object.values(c.r2Credentials ?? {}).filter(v => typeof v === 'string' && v.length > 5));
}
function redact(text) {
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']+/g, '$1?[REDACTED_QUERY]');
}
// The supervisor's own stdout may be a closed pipe (started detached, or the
// starter exited). Console output is best effort; the events file is the record.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
function event(type, extra = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), event: type, supervisorPid: process.pid, sessionId, ...extra });
  try { fs.appendFileSync(path.join(logDir, 'supervisor.events.jsonl'), redact(line) + '\n'); } catch {}
  try { console.log(redact(line)); } catch {}
}
const buildId = fs.readFileSync(path.join(release, 'BUILD_ID'), 'utf8').trim();
function verifyBuild() {
  const hash = createHash('sha256');
  for (const name of fs.readdirSync(release).filter(n => n.endsWith('.js')).sort()) {
    const bytes = fs.readFileSync(path.join(release, name)); hash.update(String(bytes.length) + ':').update(bytes);
  }
  if (hash.digest('hex') !== buildId) throw Error('BUILD_CHANGED');
}
verifyBuild();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
function claimLock() {
  try { fs.writeFileSync(lockPath, JSON.stringify({pid: process.pid, sessionId, startedAt, release, logDir}), {flag: 'wx'}); return; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // A lock whose owner no longer exists is the trace of a crashed supervisor.
  // Take it over only with that proof recorded; a live owner is never displaced.
  const previous = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (alive(previous.pid)) throw Error('SUPERVISOR_ALREADY_RUNNING');
  event('STALE_LOCK_REPLACED', {previousPid: previous.pid, previousSessionId: previous.sessionId, previousStartedAt: previous.startedAt});
  fs.writeFileSync(lockPath + '.' + process.pid + '.tmp', JSON.stringify({pid: process.pid, sessionId, startedAt, release, logDir, replacedStaleLock: previous}));
  fs.renameSync(lockPath + '.' + process.pid + '.tmp', lockPath);
}
claimLock();
let stopping = false;
let timer;
let deferredStatusWrites = 0;
function saveStatus() {
  const data = {supervisorPid: process.pid, sessionId, startedAt, updatedAt: new Date().toISOString(), release, buildId, logDir, stopping,
    workers: [...state].map(([role, s]) => ({role, pid: s.child?.pid ?? null, state: s.phase, generation: s.generation, restartCount: s.generation - 1}))};
  const temporary = statusPath + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
    const outcome = replaceFileWithRetry({renameSync: fs.renameSync, sleepSync}, temporary, statusPath, {sleepMs: 25});
    if (!outcome.replaced) { deferredStatusWrites++; event('STATUS_WRITE_DEFERRED', {code: outcome.code, attempts: outcome.attempts, deferredStatusWrites}); }
    else if (deferredStatusWrites) { event('STATUS_WRITE_RESUMED', {deferredStatusWrites}); deferredStatusWrites = 0; }
  } catch (error) { event('STATUS_WRITE_FAILED', {code: error.code ?? 'unknown'}); }
}
function finishIfStopped() {
  if (!stopping || [...state.values()].some(s => s.child)) return;
  clearInterval(timer);
  event('SUPERVISOR_STOPPED'); saveStatus();
  try {
    const ownLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (ownLock.sessionId === sessionId) fs.unlinkSync(lockPath);
  } catch (error) { event('LOCK_RELEASE_FAILED', {code: error.code ?? 'unknown'}); }
  process.exitCode = 0;
}
function stop() {
  if (stopping) return;
  stopping = true; event('SUPERVISOR_STOP_REQUESTED');
  for (const s of state.values()) {
    clearTimeout(s.restartTimer);
    if (s.child?.connected) { s.phase = 'stopping'; s.child.send({type: 'v3-stop'}, err => {if (err) event('STOP_IPC_ERROR', {code: err.code ?? 'unknown'});}); }
  }
  saveStatus(); finishIfStopped();
}
function start(role) {
  if (stopping) return;
  const s = state.get(role) ?? {generation: 0, failures: 0};
  state.set(role, s); s.generation++; s.phase = 'starting'; s.running = false;
  try { verifyBuild(); } catch { s.phase = 'blocked_build_changed'; event('WORKER_RESTART_BLOCKED', {role, reason: 'BUILD_CHANGED'}); saveStatus(); return; }
  const stem = `${role}.${s.generation}`;
  const child = fork(path.join(release, 'channel-label-worker.js'), [], {
    execPath: process.execPath, cwd: release, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {...process.env, TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), CODEX_HOME: path.join(root, 'codex-home'),
      PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? ''),
      V3_WORKER_ENABLED: 'true', V3_WORKER_CONFIG: path.join(control, `channel-label-${role}.runtime.json`),
      V3_CHANNEL_LABEL_ENABLED: 'true', V3_CHANNEL_LABEL_CONFIG: path.join(control, `channel-label-${role}.private.json`),
      V3_WORKER_HEALTH_FILE: path.join(logDir, `${role}.health.json`)}
  });
  s.child = child;
  for (const [label, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('error', () => {});
    const reader = createInterface({input: stream});
    reader.on('line', line => {
      const safe = redact(line);
      try { fs.appendFileSync(path.join(logDir, `${stem}.${label}.log`), safe + '\n'); } catch {}
      try {
        const e = JSON.parse(line);
        if (e.event === 'WORKER_RUNNING') {
          s.phase = 'running'; s.running = true; s.failures = 0;
          event('ROLE_RUNNING', {role, pid: child.pid, generation: s.generation}); saveStatus();
        }
      } catch {}
    });
  }
  child.on('error', error => event('CHILD_PROCESS_ERROR', {role, code: error.code ?? 'unknown'}));
  child.on('exit', (code, signal) => {
    s.child = null; s.phase = 'exited';
    event('WORKER_EXIT', {role, code, signal, wasRunning: s.running, generation: s.generation});
    if (!stopping) {
      // Do not loop on invalid credentials/configuration during initial deployment.
      if (!s.running) s.failures++;
      if (s.generation === 1 && !s.running || s.failures >= 5) {
        s.phase = 'blocked_startup'; event('WORKER_RESTART_BLOCKED', {role, reason: 'STARTUP_NOT_VERIFIED'});
      } else {
        const delayMs = Math.min(60000, 5000 * 2 ** Math.min(s.failures, 4));
        s.phase = 'restart_wait'; event('WORKER_RESTART_SCHEDULED', {role, delayMs});
        s.restartTimer = setTimeout(() => start(role), delayMs);
      }
    }
    saveStatus(); finishIfStopped();
  });
  event('WORKER_SPAWNED', {role, pid: child.pid, generation: s.generation}); saveStatus();
}
// An unexpected error inside the supervisor must not silently end the fleet.
// Record it and keep supervising; only an explicit stop ends this process.
process.on('uncaughtException', error => event('SUPERVISOR_UNCAUGHT_EXCEPTION', {code: error?.code ?? 'unknown', name: error?.name ?? 'Error', message: String(error?.message ?? '').slice(0, 200)}));
process.on('unhandledRejection', reason => event('SUPERVISOR_UNHANDLED_REJECTION', {name: reason?.name ?? 'Error', message: String(reason?.message ?? reason ?? '').slice(0, 200)}));
process.on('exit', code => event('SUPERVISOR_EXIT', {code, stopping, workers: [...state].map(([role, s]) => ({role, pid: s.child?.pid ?? null, state: s.phase}))}));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
event('SUPERVISOR_STARTED', {release, buildId, logDir});
for (const role of roles) start(role);
timer = setInterval(() => { try { if (fs.existsSync(stopPath)) stop(); else saveStatus(); } catch (error) { event('SUPERVISOR_TICK_ERROR', {code: error?.code ?? 'unknown'}); } }, 5000);
