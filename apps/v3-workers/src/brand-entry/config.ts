import * as fs from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { readGncPrivateJson } from '../gnc-config.js';

const path = z.string().refine(isAbsolute);
export const EntryConfigSchema = z.object({ role: z.enum(['control', 'browser']), runtimeRoot: path, journalRoot: path,
  temporalConfigFile: path, expectedBuildId: z.string().regex(/^[a-f0-9]{64}$/), sourceConfigFile: path.optional(),
  cliPath: path.optional(), taskSpaceId: z.number().int().positive().optional(), database: z.object({ connectionString: z.string(), tls: z.boolean() }).optional(),
});
export async function entryConfig(file: string) { return EntryConfigSchema.parse(await readGncPrivateJson(file)); }
export async function temporalOptions(file: string) {
  const r: any = await readGncPrivateJson(file), t = r.transport;
  if (t.mode !== 'mtls') throw Error('BRAND_ENTRY.TLS_REQUIRED');
  return { namespace: String(r.namespace), address: String(r.address), tls: { serverNameOverride: String(t.serverName),
    serverRootCACertificate: await fs.readFile(t.caFile), clientCertPair: { crt: await fs.readFile(t.certFile), key: await fs.readFile(t.keyFile) } } };
}
