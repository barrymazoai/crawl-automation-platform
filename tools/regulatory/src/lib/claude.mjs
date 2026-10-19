// One structured-output call to the Claude Code CLI that is logged in on this
// machine (`claude -p`). No tools, no settings, no saved session: the model only
// sees the prompt and answers through the JSON schema.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import pRetry from 'p-retry';

const SYSTEM = 'You read documents and answer only through the required structured output. Do not guess.';

export async function claudeJson({ prompt, schema, model, timeoutMs, retries, log }) {
  const dir = await mkdtemp(join(tmpdir(), 'regulatory-claude-'));
  return pRetry(
    async () => {
      const started = Date.now();
      const { stdout } = await execa(
        'claude',
        [
          '-p',
          '--model',
          model,
          '--output-format',
          'json',
          '--json-schema',
          JSON.stringify(schema),
          '--tools',
          '',
          '--setting-sources',
          '',
          '--no-session-persistence',
          '--system-prompt',
          SYSTEM,
        ],
        { input: prompt, cwd: dir, timeout: timeoutMs },
      );
      const out = JSON.parse(stdout);
      if (out.is_error || !out.structured_output) throw new Error(`claude: ${out.subtype ?? 'error'} ${String(out.result ?? '').slice(0, 200)}`);
      const usage = out.usage ?? {};
      return {
        answer: out.structured_output,
        // The model that answered, e.g. "claude-haiku-5-5" for the "haiku" alias.
        model: Object.keys(out.modelUsage ?? {})[0] ?? model,
        tokens:
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.output_tokens ?? 0),
        cost_usd: out.total_cost_usd ?? null,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    },
    {
      retries,
      minTimeout: 30_000,
      factor: 2,
      onFailedAttempt: ({ error, attemptNumber, retriesLeft }) =>
        log.warn({ attemptNumber, retriesLeft, err: error.shortMessage ?? error.message }, 'claude call failed'),
    },
  );
}
