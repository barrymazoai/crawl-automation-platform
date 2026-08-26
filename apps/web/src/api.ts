import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract } from "@crawl-automation/contracts/app-contract";

const link = new RPCLink({ url: () => `${window.location.origin}/api/rpc` });
export const api = createORPCClient<ContractRouterClient<AppContract>>(link);

