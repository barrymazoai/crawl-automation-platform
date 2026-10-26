// node src/push-trials.mjs --supply-smart-env <file> --delivery <dir> [--dry-run]
//
// Pushes one trial delivery folder of tools/clinical-trials by hand, as the scheduled job does
// (src/push.mjs): dry runs first, then the real batches. For a corrected delivery, e.g. 2026-10-26, when
// one without the wrong ingredient links was pushed to take them back. The delivery's manifest run_id
// must be new to Supply Smart, or its batches are re-sends of another delivery (409).
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { pushTrials } from './push.mjs';
import { supplySmartFromEnvFile } from './lib/supply-smart.mjs';

const { values: args } = parseArgs({
  options: {
    'supply-smart-env': { type: 'string' },
    delivery: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!args['supply-smart-env'] || !args.delivery) throw new Error('--supply-smart-env and --delivery are required');
const log = pino({ timestamp: pino.stdTimeFunctions.isoTime });
const supplySmart = await supplySmartFromEnvFile(args['supply-smart-env'], { log });
console.log(JSON.stringify(await pushTrials({ deliveryDir: resolve(args.delivery), supplySmart, log, dryOnly: args['dry-run'] })));
