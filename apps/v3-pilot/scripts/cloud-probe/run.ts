import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { msToTs } from '@temporalio/common/lib/time.js';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import type { ProbeInput, ProbeResult } from './workflow.js';

const root = new URL('../../../../infra/temporal/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('deployment.json', root), 'utf8')) as {
  projectId: string; address: string; tlsServerName: string; namespace: string;
};
// This is a separate opt-in runner; the existing local-only business pilot remains guarded.
if (process.env.V3_ALLOW_CLOUD_PROBE !== manifest.projectId) {
  throw new Error('Explicit V3_ALLOW_CLOUD_PROBE=<deployment project ID> is required');
}
const tls = {
  serverNameOverride: manifest.tlsServerName,
  serverRootCACertificate: await readFile(new URL('.local/ca.pem', root)),
  clientCertPair: {
    crt: await readFile(new URL('.local/mac-worker.pem', root)),
    key: await readFile(new URL('.local/mac-worker-key.pem', root)),
  },
};
const connection = await Connection.connect({ address: manifest.address, tls, connectTimeout: '20 seconds' });
const client = new Client({ connection, namespace: manifest.namespace });
const phase = process.argv[2] ?? 'smoke';
const workerIdentity = `mac-cloud-probe@${hostname()}:${process.pid}`;
const stateUrl = new URL(`.local/${phase === 'smoke' ? 'smoke' : 'restart'}-probe.json`, root);
let workerConnection: NativeConnection | undefined;
try {
  if (!['smoke', 'prepare-restart', 'resume-restart'].includes(phase)) throw new Error('Unknown phase');
  try {
    await connection.workflowService.describeNamespace({ namespace: manifest.namespace });
  } catch (error) {
    if ((error as { code?: number }).code !== 5) throw error;
    await connection.workflowService.registerNamespace({ namespace: manifest.namespace,
      description: 'Isolated V3 integration probes; no live crawler tasks',
      workflowExecutionRetentionPeriod: msToTs('7 days') });
    // Namespace registration propagates asynchronously inside Temporal.
    await delay(5000);
  }
  if (phase === 'smoke') {
    let unauthorized: Connection | undefined;
    try {
      unauthorized = await Connection.connect({ address: manifest.address,
        tls: { serverNameOverride: tls.serverNameOverride, serverRootCACertificate: tls.serverRootCACertificate },
        connectTimeout: '5 seconds' });
    } catch { console.log('OBSERVED: connection without client certificate did not succeed (not alone proof of TLS rejection)'); }
    if (unauthorized) { await unauthorized.close(); throw new Error('Unauthenticated connection unexpectedly succeeded'); }
  }
  const state = phase === 'resume-restart'
    ? JSON.parse(await readFile(stateUrl, 'utf8')) as { workflowId: string; taskQueue: string; token: string; activityCalls: number }
    : { workflowId: `railway-${phase}-${randomUUID()}`, taskQueue: `v3-cloud-probe-${randomUUID()}`, token: randomUUID(), activityCalls: 0 };
  const handle = phase === 'resume-restart'
    ? client.workflow.getHandle(state.workflowId)
    : await client.workflow.start('cloudConnectivityProbe', {
      workflowId: state.workflowId, taskQueue: state.taskQueue,
      args: [{ token: state.token, pause: phase === 'prepare-restart' }],
      workflowExecutionTimeout: phase === 'smoke' ? '2 minutes' : '2 hours',
    });
  if (phase !== 'resume-restart') {
    const history = await handle.fetchHistory();
    assert(history.events?.some(e => e.workflowExecutionStartedEventAttributes));
    assert(!history.events?.some(e => e.workflowTaskStartedEventAttributes));
    console.log('PASS: workflow persisted in cloud before any local Worker started');
    await writeFile(stateUrl, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } else {
    assert.equal((await handle.describe()).status.name, 'RUNNING');
    console.log('PASS: waiting workflow still RUNNING after remote restart');
  }
  const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('workflow.ts', import.meta.url)) });
  workerConnection = await NativeConnection.connect({ address: manifest.address, tls });
  let callsThisProcess = 0;
  const worker = await Worker.create({ connection: workerConnection, namespace: manifest.namespace,
    identity: workerIdentity, taskQueue: state.taskQueue, workflowBundle: bundle,
    shutdownGraceTime: '3 seconds', shutdownForceTime: '10 seconds',
    maxConcurrentActivityTaskExecutions: 1,
    activities: { async echoOnLocalMachine(input: ProbeInput): Promise<ProbeResult> {
      callsThisProcess++;
      console.log('PASS: Activity executing locally', { hostname: hostname(), platform: process.platform, pid: process.pid, workerIdentity });
      return { token: input.token, executedOn: hostname(), executedAt: new Date().toISOString(),
        platform: process.platform, pid: process.pid, workerIdentity };
    } },
  });
  await worker.runUntil(async () => {
    if (phase === 'prepare-restart') {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (await handle.query('probeStage') === 'waiting-for-release') {
          assert.equal(callsThisProcess, 1);
          state.activityCalls = callsThisProcess;
          await writeFile(stateUrl, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
          console.log('READY_FOR_RESTART', state.workflowId);
          return;
        }
        await delay(500);
      }
      throw new Error('Workflow did not reach persisted wait state');
    }
    if (phase === 'resume-restart') await handle.signal('releaseProbe');
    const result = await handle.result() as ProbeResult;
    assert.equal(result.token, state.token);
    assert.equal(result.executedOn, hostname());
    assert.equal(result.platform, process.platform);
    if (phase === 'smoke') {
      assert.equal(result.platform, 'darwin', 'This acceptance probe must run on the local Mac');
      assert.equal(result.pid, process.pid);
      assert.equal(result.workerIdentity, workerIdentity);
    }
    assert.equal(callsThisProcess, phase === 'resume-restart' ? 0 : 1);
    const description = await handle.describe();
    assert.equal(description.status.name, 'COMPLETED');
    const history = await handle.fetchHistory();
    const scheduledActivities = history.events?.filter(e => e.activityTaskScheduledEventAttributes).length;
    assert.equal(scheduledActivities, 1);
    const workflowTaskIdentities = [...new Set(history.events?.flatMap(e =>
      e.workflowTaskStartedEventAttributes ? [e.workflowTaskStartedEventAttributes.identity] : []))];
    const activityTaskIdentities = [...new Set(history.events?.flatMap(e =>
      e.activityTaskStartedEventAttributes ? [e.activityTaskStartedEventAttributes.identity] : []))];
    if (phase === 'smoke') {
      assert.deepEqual(workflowTaskIdentities, [workerIdentity]);
      assert.deepEqual(activityTaskIdentities, [workerIdentity]);
    }
    const uiUrl = `https://temporal-ui-production-1288.up.railway.app/namespaces/${manifest.namespace}/workflows/${state.workflowId}/${description.runId}/timeline`;
    const evidence = { ...state, result, status: description.status.name, activityCallsThisProcess: callsThisProcess,
      scheduledActivities, runId: description.runId, workflowTaskIdentities, activityTaskIdentities, uiUrl,
      verifiedAt: new Date().toISOString(), address: manifest.address, phase };
    await writeFile(stateUrl, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log('PASS:', JSON.stringify(evidence));
  });
} finally {
  await workerConnection?.close();
  await connection.close();
}
