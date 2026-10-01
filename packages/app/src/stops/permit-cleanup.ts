export interface PermitCleanup {
  state: "armed" | "running" | "stopped" | "CLEANUP_UNVERIFIED";
  attempts: number;
  failure: Record<string, unknown> | null;
  executions: Array<{
    identity: Record<string, unknown>;
    stoppedAt: string | null;
    proof: Record<string, unknown> | null;
  }>;
}
