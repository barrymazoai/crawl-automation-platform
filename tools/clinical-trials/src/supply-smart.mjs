// Supply Smart product database gateway (oRPC, `x-api-key` service key), read-only calls only.
// The crawler touches Supply Smart through its API; ids in the delivered files come from here.
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import pThrottle from 'p-throttle';
import { z } from 'zod';

const CompanyList = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) });
const BrandedIngredientList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      externalKey: z.string().nullish(),
      name: z.string(),
      genericName: z.string().nullish(),
      aliases: z.array(z.string()).nullish(),
      supplier: z.object({ id: z.string(), name: z.string() }).nullish(),
    }),
  ),
});
const BrandedIngredientDetail = z.object({ aliases: z.array(z.string()).nullish() });
const ProductPage = z.object({
  products: z.array(z.object({ id: z.string(), name: z.string(), companyId: z.string().nullable() })),
  total: z.number(),
});

export function createSupplySmart({ databaseRpcUrl, apiKey, requestsPerMinute = 120 }) {
  if (!databaseRpcUrl || !apiKey) throw new Error('SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY are required');
  const client = createORPCClient(new RPCLink({ url: databaseRpcUrl, headers: { 'x-api-key': apiKey } }));
  const paced = pThrottle({ limit: 1, interval: Math.ceil(60_000 / requestsPerMinute) })((run) => run());
  const call = async (path, input, schema) => {
    const [router, procedure] = path.split('.');
    return schema.parse(await paced(() => client[router][procedure](input)));
  };

  return {
    source: new URL(databaseRpcUrl).host,
    async companies() {
      return (await call('company.allNamesAndId', undefined, CompanyList)).data;
    },
    /** The list has no aliases; brandedIngredientAliases reads them one ingredient at a time. */
    async brandedIngredients() {
      return (await call('brandedIngredient.list', undefined, BrandedIngredientList)).data;
    },
    async brandedIngredientAliases(id) {
      return (await call('brandedIngredient.getDetail', { id }, BrandedIngredientDetail)).aliases ?? [];
    },
    /** Every SKU of the given companies (100 per page). */
    async products(companyIds) {
      const out = [];
      for (let i = 0; i < companyIds.length; i += 50) {
        const ids = companyIds.slice(i, i + 50);
        for (let page = 1; ; page += 1) {
          const answer = await call('product.listAdvanced', { companyIds: ids, page, pageSize: 100, viewMode: 'skus' }, ProductPage);
          out.push(...answer.products.map((p) => ({ id: p.id, name: p.name, company_id: p.companyId })));
          if (page * 100 >= answer.total || answer.products.length === 0) break;
        }
      }
      return out;
    },
  };
}
