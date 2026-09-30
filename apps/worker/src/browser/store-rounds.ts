import {
  EGO_MARKER,
  EgoRunner,
  egoErrors,
  type EgoPages,
  type EgoSettings,
} from "@crawl-automation/platform";

/** Managed Store page lifecycle. The user-control boundary is checked again before closing. */
export function storeRoundScript(body: string, params: object): string {
  return `
const params = ${JSON.stringify(params)};
const emit = value => console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify(value));
const task = await taskSpace(params.taskSpaceId);
if (task.ownership === 'user') { emit({ kind: 'stop', reason: 'user-control' }); return; }
const page = await task.newPage();
const targetId = page.targetId;
emit({ kind: 'opened', targetId });
let value = null;
let failure = null;
try {
  value = await (async () => { ${body}\n })();
} catch (error) {
  failure = { name: String(error?.name ?? 'Error'), code: error?.code ?? null };
}
let closed = false;
if (task.ownership !== 'user') {
  try {
    await page.close();
  } catch (error) {
    failure ??= { name: String(error?.name ?? 'Error'), code: error?.code ?? null };
  }
  for (let attempt = 0; attempt < 4 && task.ownership !== 'user'; attempt++) {
    closed = !(await task.tabs()).some(tab => tab.targetId === targetId);
    if (closed) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
emit({ kind: 'result', targetId, closed, failure, value });`;
}

/** Uses the platform executor/protocol; only the Store round's stronger lifecycle differs. */
export class StoreEgoRounds {
  private readonly runner: EgoRunner;
  constructor(private readonly deps: { settings: EgoSettings; pages: EgoPages }) {
    this.runner = new EgoRunner(deps.settings);
  }

  async round(body: string, params: object, signal: AbortSignal): Promise<unknown> {
    const script = storeRoundScript(body, {
      ...params,
      taskSpaceId: this.deps.settings.taskSpaceId,
    });
    const result = await this.runner.run(script, signal);
    if (result.failure) {
      throw egoErrors.create("BROWSER.UNAVAILABLE", { details: { failure: result.failure } });
    }
    return result.value;
  }

  closeTarget(targetId: string, signal: AbortSignal): Promise<void> {
    return this.deps.pages.closeTarget(targetId, signal);
  }
}
