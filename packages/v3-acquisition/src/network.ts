import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { AcquisitionError, type Address, type DnsResolver, type FileTransport, type Response } from "./ports.js";
export function publicAddress(raw: string): boolean {
    if (!isIP(raw) || raw.includes("%"))
        return false;
    const ip = ipaddr.parse(raw);
    // Do not unwrap mapped, translated or tunneled IPv6 into apparently public IPv4.
    return ip.range() === "unicast" && (ip.kind() === "ipv4" || ip.match(ipaddr.parse("2000::"), 3));
}
export function permittedUrl(raw: string, allowedOrigins: readonly string[]): URL {
    let url: URL;
    try {
        url = new URL(raw);
    }
    catch {
        throw new AcquisitionError("SOURCE.ORIGIN_BLOCKED");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
        url.hostname.endsWith(".") || isIP(url.hostname.replace(/^\[|\]$/g, "")) || !allowedOrigins.includes(url.origin))
        throw new AcquisitionError("SOURCE.ORIGIN_BLOCKED");
    return url;
}
export const systemDns: DnsResolver = {
    async resolve(hostname, signal) {
        signal.throwIfAborted();
        const addresses = await lookup(hostname, { all: true, verbatim: true });
        signal.throwIfAborted();
        return addresses.map(a => ({ address: a.address, family: a.family as 4 | 6 }));
    },
};
export async function pinAddress(url: URL, dns: DnsResolver, signal: AbortSignal): Promise<Address> {
    let answers: Address[];
    try {
        answers = await dns.resolve(url.hostname, signal);
    }
    catch {
        signal.throwIfAborted();
        throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");
    }
    signal.throwIfAborted();
    if (!answers.length || answers.some(a => !publicAddress(a.address) || isIP(a.address) !== a.family))
        throw new AcquisitionError("SOURCE.SSRF_BLOCKED");
    return answers[0]!;
}
/** Explicit direct route. Never reads proxy environment variables or falls back from another route. */
export class DirectHttpsTransport implements FileTransport {
    readonly egressId = "direct/1";
    readonly targetResolution = "local-pinned" as const;
    async get(url: URL, address: Address | undefined, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Response> {
        permittedUrl(url.href, [url.origin]);
        if (!address || !publicAddress(address.address) || isIP(address.address) !== address.family)
            throw new AcquisitionError("SOURCE.SSRF_BLOCKED");
        return new Promise((resolve, reject) => {
            const req = request(url, { method: "GET", agent: false, signal, maxHeaderSize: 16 * 1024,
                family: address.family, servername: url.hostname,
                lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
                headers: { ...headers, "accept-encoding": "identity" }, rejectUnauthorized: true,
            }, res => {
                const h: Record<string, string | undefined> = {};
                for (const name of ["content-type", "content-length", "content-encoding", "location"]) {
                    const value = res.headers[name];
                    h[name] = Array.isArray(value) ? value.join(",") : value;
                }
                resolve({ status: res.statusCode ?? 0, headers: h, body: res, close: () => res.destroy() });
            });
            req.on("error", () => reject(new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE")));
            req.end();
        });
    }
}

/** Select resolution by the trusted transport, never by task input or DNS failure fallback. */
export async function transportAddress(url: URL, transport: FileTransport, dns: DnsResolver, signal: AbortSignal): Promise<Address | undefined> {
    signal.throwIfAborted();
    if (transport.targetResolution === "proxy" || transport.targetResolution === "browser") return undefined;
    return pinAddress(url, dns, signal);
}
