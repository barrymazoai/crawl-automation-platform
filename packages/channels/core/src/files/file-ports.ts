import type { FileAcquireInput, SourceBinding, Observation } from "@crawl-automation/v3-contracts";
export type Address = {
  address: string;
  family: 4 | 6;
};
export interface DnsResolver {
  resolve(hostname: string, signal: AbortSignal): Promise<Address[]>;
}
export type Response = {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
};
/** Trusted adapter: one HTTPS GET, no redirect/retry, preserve TLS hostname.
 * Proxy/browser transports delegate target resolution to that operator-trusted runtime.
 * Omitted resolution mode preserves the pinned-address contract for existing host adapters.
 */
export interface FileTransport {
  readonly egressId: string;
  readonly targetResolution?: "local-pinned" | "proxy" | "browser" | "system";
  get(
    url: URL,
    address: Address | undefined,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<Response>;
}
/** Acquire pins BOTH source session and egress until release; other operations may acquire independent leases. */
export interface SourceLease {
  readonly owner: Observation;
  readonly sourceId: string;
  readonly binding: SourceBinding;
  readonly resourceId: string;
  readonly url: string;
  readonly allowedOrigins: readonly string[];
  readonly transport: FileTransport;
  assertActive(): void;
  headersFor(origin: string): Readonly<Record<string, string>>;
  /** Optional narrower authorization for an exact URL; never expands cross-origin forwarding. */
  headersForUrl?(url: string): Readonly<Record<string, string>>;
  release(): Promise<void>;
}
export interface SourceAccess {
  acquire(input: FileAcquireInput, signal: AbortSignal): Promise<SourceLease>;
}
