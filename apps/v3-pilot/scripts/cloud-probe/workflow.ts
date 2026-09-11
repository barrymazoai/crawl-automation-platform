import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

export interface ProbeInput { token: string; pause: boolean }
export interface ProbeResult {
  token: string;
  executedOn: string;
  executedAt: string;
  platform: string;
  pid: number;
  workerIdentity: string;
}
export const releaseProbe = defineSignal('releaseProbe');
export const probeStage = defineQuery<string>('probeStage');
const { echoOnLocalMachine } = proxyActivities<{
  echoOnLocalMachine(input: ProbeInput): Promise<ProbeResult>;
}>({ startToCloseTimeout: '15 seconds', retry: { maximumAttempts: 2 } });

// Isolated synthetic probe. No crawler, OCR, product DB, filesystem or network activity.
export async function cloudConnectivityProbe(input: ProbeInput): Promise<ProbeResult> {
  let stage = 'starting';
  let released = false;
  setHandler(releaseProbe, () => { released = true; });
  setHandler(probeStage, () => stage);
  const result = await echoOnLocalMachine(input);
  if (input.pause) {
    stage = 'waiting-for-release';
    await condition(() => released);
  }
  stage = 'completed';
  return result;
}
