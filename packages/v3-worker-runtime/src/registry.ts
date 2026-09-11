import type { WorkerOptions } from "@temporalio/worker";
import type { WorkerConfig } from "./config.js";
import { Token } from "./config.js";

export type PreparedRole =
  | { kind: "workflow"; workflowBundle: NonNullable<WorkerOptions["workflowBundle"]>; dispose(): Promise<void> }
  | { kind: "activity"; activities: Record<string, (...args: unknown[]) => Promise<unknown>>; dispose(): Promise<void> };
export interface RoleDefinition {
  role: string;
  kind: "workflow" | "activity";
  capability: string;
  contractVersion: number;
  compatibility: string;
  buildId: string;
  testOnly: boolean;
  sessionScoped?: true;
  // Factory owns its partial allocations if preparation fails; successful allocation transfers ownership.
  prepare(config: Readonly<WorkerConfig>, signal: AbortSignal): Promise<PreparedRole>;
}
export class RoleRegistry {
  private readonly roles = new Map<string, Readonly<RoleDefinition>>();
  constructor(readonly mode: "business" | "test", definitions: readonly RoleDefinition[]) {
    const queues = new Set<string>();
    for (const d of definitions) {
      if (!Token.safeParse(d.role).success || !Token.safeParse(d.compatibility).success ||
          !/^[a-z][a-z0-9.-]{0,100}$/.test(d.capability) || !Number.isSafeInteger(d.contractVersion) || d.contractVersion < 1 ||
          !/^[a-f0-9]{64}$/.test(d.buildId) || !["workflow", "activity"].includes(d.kind) ||
          typeof d.prepare !== "function" || d.testOnly !== (mode === "test")) throw new Error("Invalid or cross-environment role registration");
      const queue = `${d.capability}.v${d.contractVersion}.${d.compatibility}`;
      if (this.roles.has(d.role) || queues.has(queue)) throw new Error("Duplicate role or capability queue");
      queues.add(queue); this.roles.set(d.role, Object.freeze({ ...d }));
    }
  }
  list() { return [...this.roles.values()].map(({ prepare: _prepare, ...metadata }) => metadata); }
  select(config: WorkerConfig) {
    const role = this.roles.get(config.role);
    if (!role) throw new Error("V3 role is not implemented/registered in this deployment");
    if (config.capability !== role.capability || config.contractVersion !== role.contractVersion ||
        config.compatibility !== role.compatibility || config.expectedBuildId !== role.buildId)
      throw new Error("Worker capability/version/build mismatch");
    if (role.kind === "workflow" && config.concurrency < 2) throw new Error("Workflow task concurrency must be at least 2 with the configured sticky cache");
    if ((this.mode === "test") !== !!config.testSession ||
        (this.mode === "test" && (config.transport.mode !== "local" || config.namespace !== "default")))
      throw new Error("Test and business deployments must be isolated");
    if (config.queueScope && !role.sessionScoped) throw new Error("Role does not accept session-scoped routing");
    const taskQueue = taskQueueFor(config);
    return { role, taskQueue };
  }
}
export function taskQueueFor(config: Pick<WorkerConfig,"capability"|"contractVersion"|"compatibility"|"testSession"|"queueScope">) {
  if(config.queueScope && !Token.safeParse(config.queueScope).success) throw new Error("Invalid queue scope");
  const name=`${config.testSession?`v3.test.${config.testSession}`:"v3"}.${config.capability}.v${config.contractVersion}.${config.compatibility}${config.queueScope?`.session.${config.queueScope}`:""}`;
  if(name.length>255)throw new Error("Capability queue name too long");return name;
}
