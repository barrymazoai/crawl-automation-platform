import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { defineErrors } from "@crawl-automation/platform";
import { z } from "zod";
import { ApolloSettingsSchema, type ApolloSettings } from "../apollo/apollo-client.js";
import { SupplySmartSettingsSchema, type SupplySmartSettings } from "./supply-smart-rpc.js";

const secretErrors = defineErrors({
  "BRAND_ENRICHMENT.SECRETS_INVALID": {
    category: "RUNTIME",
    message: "The brand enrichment secrets file is missing a value or has an invalid one.",
  },
});

const SupplySmartFileSchema = z.object({
  SUPPLY_SMART_API_KEY: z.string().min(1),
  SUPPLY_SMART_BIZ_RPC_URL: z.url(),
  SUPPLY_SMART_DATABASE_RPC_URL: z.url(),
});
const SecretsFileSchema = SupplySmartFileSchema.extend({ APOLLO_API_KEY: z.string().min(1) });

export interface BrandEnrichmentSecrets {
  supplySmart: SupplySmartSettings;
  apollo: ApolloSettings;
}

/**
 * Reads the private `.env.brand-enrichment` file (gitignored, copied to the server by SCP only) with Node's own
 * `.env` parser. A bad file names the missing keys, never their values.
 */
export async function loadBrandEnrichmentSecrets(path: string): Promise<BrandEnrichmentSecrets> {
  const secrets = await secretsFile(path, SecretsFileSchema);
  return {
    supplySmart: supplySmartSettings(secrets),
    apollo: ApolloSettingsSchema.parse({ apiKey: secrets.APOLLO_API_KEY }),
  };
}

/**
 * KAN-243: another Supply Smart's address and service key alone (the test database amazon.in is sent to), in the same
 * private `.env` form.
 */
export async function loadSupplySmartSecrets(path: string): Promise<SupplySmartSettings> {
  return supplySmartSettings(await secretsFile(path, SupplySmartFileSchema));
}

async function secretsFile<Schema extends z.ZodType>(path: string, schema: Schema) {
  const parsed = schema.safeParse(parseEnv(await readFile(path, "utf8")));
  if (!parsed.success) {
    throw secretErrors.create("BRAND_ENRICHMENT.SECRETS_INVALID", {
      details: { path, keys: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  return parsed.data as z.infer<Schema>;
}

function supplySmartSettings(secrets: z.infer<typeof SupplySmartFileSchema>) {
  return SupplySmartSettingsSchema.parse({
    bizRpcUrl: secrets.SUPPLY_SMART_BIZ_RPC_URL,
    databaseRpcUrl: secrets.SUPPLY_SMART_DATABASE_RPC_URL,
    apiKey: secrets.SUPPLY_SMART_API_KEY,
  });
}
