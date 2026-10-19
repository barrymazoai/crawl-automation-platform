// node src/ai-ingredients.mjs --data-dir <dir> (--slugs a,b | --slugs-file f.json | --scope dietary_supplement)
//   [--provider claude|codex] [--model haiku] [--effort medium] [--concurrency 1] [--redo]
//
// Reads each warning letter from the cache (no web request), asks the model for
// the ingredients it names, keeps only quote-verified items and writes
// <dir>/ai/warning-letter-ingredients/<slug>.json. warning_letter.jsonl is not
// changed. A letter that already has an answer for its current text and prompt
// is skipped, whichever model gave it, unless --redo.
// Owner 2026-10-19: new letters are read by Claude Haiku (`claude -p`); the
// 2026-10-18 answers came from Codex gpt-5.6-luna (`--provider codex`).
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pLimit from 'p-limit';
import pino from 'pino';
import { claudeJson } from './lib/claude.mjs';
import { codexJson } from './lib/codex.mjs';
import { createHttp } from './lib/http.mjs';
import { loadKind, readJson, writeJson } from './lib/store.mjs';
import {
  PROMPT_VERSION,
  SCHEMA,
  buildPrompt,
  isCurrent,
  letterText,
  resultPath,
  textHash,
  verify,
} from './sources/warning-letter-ai.mjs';
import { parseLetter } from './sources/warning-letters.mjs';

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: process.env.REGULATORY_DATA_DIR },
    slugs: { type: 'string' },
    'slugs-file': { type: 'string' },
    scope: { type: 'string' },
    provider: { type: 'string', default: 'claude' },
    model: { type: 'string' },
    effort: { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    redo: { type: 'boolean', default: false },
  },
});
if (!args['data-dir']) throw new Error('--data-dir (or REGULATORY_DATA_DIR) is required');
const PROVIDERS = {
  claude: { model: 'haiku', effort: null, call: claudeJson },
  codex: { model: 'gpt-5.6-luna', effort: 'medium', call: codexJson },
};
const provider = PROVIDERS[args.provider];
if (!provider) throw new Error(`--provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
const model = args.model ?? provider.model;
const effort = args.provider === 'codex' ? (args.effort ?? provider.effort) : null;
const dataDir = resolve(args['data-dir']);
const now = new Date().toISOString();
const runDir = join(dataDir, 'runs', `${now.replace(/[:.]/g, '-')}-ai-ingredients`);
const outDir = join(dataDir, 'ai', 'warning-letter-ingredients');
await mkdir(runDir, { recursive: true });
await mkdir(outDir, { recursive: true });
const log = pino(
  { timestamp: pino.stdTimeFunctions.isoTime },
  pino.multistream([{ stream: process.stdout }, { stream: pino.destination({ dest: join(runDir, 'run.log'), sync: true }) }]),
);

const letters = [...(await loadKind(join(dataDir, 'warning_letter.jsonl'))).values()];
let slugs;
if (args.slugs) slugs = args.slugs.split(',').map((s) => s.trim());
else if (args['slugs-file'])
  slugs = JSON.parse(await readFile(args['slugs-file'], 'utf8')).map((s) => (typeof s === 'string' ? s : s.slug));
else if (args.scope) slugs = letters.filter((r) => r.details.scope === args.scope).map((r) => r.source_key);
else throw new Error('give --slugs, --slugs-file or --scope');
const bySlug = new Map(letters.map((r) => [r.source_key, r]));
const missing = slugs.filter((s) => !bySlug.has(s));
if (missing.length) throw new Error(`not in warning_letter.jsonl: ${missing.join(', ')}`);

const cache = createHttp({ cacheDir: join(dataDir, 'cache'), log, offline: true }).forSource();
const summary = { started_at: now, provider: args.provider, model, effort, prompt_version: PROMPT_VERSION, letters: [] };

const limit = pLimit(Number(args.concurrency));
await Promise.all(
  slugs.map((slug) =>
    limit(async () => {
      const record = bySlug.get(slug);
      const page = await cache.get(record.source_url);
      const text = letterText(parseLetter(page.body.toString('utf8')));
      const inputHash = textHash(text);
      const file = resultPath(dataDir, slug);
      const prior = await readJson(file);
      if (!args.redo && isCurrent(prior, text)) {
        summary.letters.push({ slug, skipped: 'current', model: prior.model, kept: prior.ingredients.length });
        return;
      }
      try {
        const answered = await provider.call({
          prompt: buildPrompt(text),
          schema: SCHEMA,
          model,
          effort,
          timeoutMs: 10 * 60_000,
          retries: 2,
          log: log.child({ slug }),
        });
        const { answer, tokens, seconds } = answered;
        const { kept, dropped } = verify(text, answer.ingredients ?? []);
        await writeJson(file, {
          slug,
          source_url: record.source_url,
          provider: args.provider,
          model: answered.model ?? model,
          effort,
          prompt_version: PROMPT_VERSION,
          input_sha256: inputHash,
          extracted_at: new Date().toISOString(),
          tokens,
          cost_usd: answered.cost_usd ?? null,
          seconds,
          ingredients: kept,
          dropped,
          rule_ingredients: record.details.ingredients_mentioned,
        });
        summary.letters.push({ slug, kept: kept.length, dropped: dropped.length, tokens, seconds });
        log.info({ slug, kept: kept.length, dropped: dropped.length, tokens, seconds }, 'letter done');
      } catch (error) {
        summary.letters.push({ slug, error: error.shortMessage ?? error.message });
        log.error({ slug, err: error.shortMessage ?? error.message }, 'letter failed');
      }
    }),
  ),
);
summary.finished_at = new Date().toISOString();
summary.tokens = summary.letters.reduce((n, l) => n + (l.tokens ?? 0), 0);
summary.failed = summary.letters.filter((l) => l.error).length;
await writeJson(join(runDir, 'summary.json'), summary);
log.info({ letters: summary.letters.length, failed: summary.failed, tokens: summary.tokens }, 'run finished');
