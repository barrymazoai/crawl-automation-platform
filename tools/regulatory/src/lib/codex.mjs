// One structured-output call to the Codex CLI that is logged in on this
// machine. The model runs in a read-only sandbox in an empty directory; it only
// sees the prompt.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import pRetry from 'p-retry';

export async function codexJson({ prompt, schema, model, effort, timeoutMs, retries, log }) {
  const dir = await mkdtemp(join(tmpdir(), 'regulatory-codex-'));
  const schemaFile = join(dir, 'schema.json');
  const outFile = join(dir, 'answer.json');
  await writeFile(schemaFile, JSON.stringify(schema));
  return pRetry(
    async () => {
      const started = Date.now();
      const result = await execa(
        'codex',
        [
          'exec',
          '-m',
          model,
          '-c',
          `model_reasoning_effort="${effort}"`,
          '--sandbox',
          'read-only',
          '--ephemeral',
          '--skip-git-repo-check',
          '--output-schema',
          schemaFile,
          '-o',
          outFile,
          '-',
        ],
        { input: prompt, cwd: dir, timeout: timeoutMs, all: true },
      );
      const tokens = Number(result.all.match(/tokens used\s+([\d,]+)/)?.[1].replace(/,/g, '') ?? NaN);
      return {
        answer: JSON.parse(await readFile(outFile, 'utf8')),
        tokens: Number.isNaN(tokens) ? null : tokens,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    },
    {
      retries,
      minTimeout: 30_000,
      factor: 2,
      onFailedAttempt: ({ error, attemptNumber, retriesLeft }) =>
        log.warn({ attemptNumber, retriesLeft, err: error.shortMessage ?? error.message }, 'codex call failed'),
    },
  );
}
