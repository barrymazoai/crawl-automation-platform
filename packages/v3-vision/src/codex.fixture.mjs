import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => emit({ method, params });
let thread;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return emit({ id, result: {} });
  if (method === 'initialized') return;
  if (method === 'config/read') return emit({ id, result: { config: { model_provider: 'fixture' } } });
  if (method === 'model/list') return emit({ id, result: { data: [{ id: 'fixture', model: 'fixture', inputModalities: process.argv[2] === 'text-only' ? ['text'] : ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null } });
  if (method === 'thread/start') { thread = params; return emit({ id, result: { thread: { id: 'thread' }, model: params.model, modelProvider: params.modelProvider, cwd: params.cwd, reasoningEffort: params.config.model_reasoning_effort, approvalPolicy: 'never', sandbox: { type: 'readOnly' } } }); }
  if (method === 'turn/start') {
    if (params.input.length !== 2 || params.input[1].type !== 'localImage' || params.input[1].detail !== 'original' || params.effort !== 'medium' || thread.sandbox !== 'read-only') throw Error('INVALID_IMAGE_TURN');
    const hash = createHash('sha256').update(readFileSync(params.input[1].path)).digest('hex');
    let answer = JSON.stringify({ hash });
    if (process.argv[2] === 'label-result') {
      if (params.outputSchema?.properties?.codec?.const !== 'label-extraction/1' || !params.input[0].text.includes('SAME row')) throw Error('INVALID_LABEL_PROTOCOL');
      const fixture = JSON.parse(readFileSync(process.argv[3], 'utf8'));
      if (fixture.imageSha256 !== hash) throw Error('ORIGINAL_BYTES_CHANGED');
      answer = JSON.stringify(fixture.candidate);
    }
    emit({ id, result: { turn: { id: 'turn' } } });
    notify('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } });
    notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', error: null } }); return;
  }
  throw Error('Unexpected method');
});
