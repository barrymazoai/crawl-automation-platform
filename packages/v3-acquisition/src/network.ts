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
/** DNS over HTTPS (RFC 8484 JSON API, Cloudflare by default): real public answers on hosts whose system resolver
 * hands out fake addresses (Clash fake-ip mode returns 198.18.0.0/15, which the SSRF guard rightly refuses).
 * IPv4 only: the direct transport pins one address and the crawl hosts route IPv4. The SSRF guard still applies. */
export function dohDns(endpoint = "https://cloudflare-dns.com/dns-query", fetchImpl: typeof fetch = fetch): DnsResolver {
    return {
        async resolve(hostname, signal) {
            let answer: { Status?: number; Answer?: { type: number; data: string }[] };
            try {
                const r = await fetchImpl(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`, { headers: { accept: "application/dns-json" }, signal, redirect: "error" });
                if (!r.ok) throw new Error(String(r.status));
                answer = await r.json() as typeof answer;
            }
            catch {
                signal.throwIfAborted();
                throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");
            }
            if (answer.Status !== 0) throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");
            const out: Address[] = (answer.Answer ?? []).filter(a => a.type === 1 && isIP(a.data) === 4).map(a => ({ address: a.data, family: 4 as const }));
            if (!out.length) throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");
            return out;
        },
    };
}
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

/** Direct route that leaves name resolution to the host (system resolver, or the TUN proxy on a Clash host).
 * No address pinning and no public-address check: chosen by the operator for CDN downloads whose URLs come from a
 * trusted channel (Amazon's own image CDN), where the SSRF guard only ever cost a DNS round trip per file. */
export class SystemHttpsTransport implements FileTransport {
    readonly egressId = "direct-system/1";
    readonly targetResolution = "system" as const;
    async get(url: URL, _address: Address | undefined, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Response> {
        permittedUrl(url.href, [url.origin]);
        return new Promise((resolve, reject) => {
            const req = request(url, { method: "GET", agent: false, signal, maxHeaderSize: 16 * 1024, servername: url.hostname,
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
    if (transport.targetResolution === "proxy" || transport.targetResolution === "browser" || transport.targetResolution === "system") return undefined;
    return pinAddress(url, dns, signal);
}
