import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAcquireInputSchema } from "@crawl-automation/v3-contracts";
import { acquireFile, FILE_POLICY } from "./file.js";
import { publicAddress, permittedUrl, pinAddress } from "./network.js";
import { AcquisitionError, type SourceLease, type Address } from "./ports.js";
import { fileInput, lease, png, response, sign } from "./testing.fixture.js";
import { hash } from "./core.js";
const signal = () => new AbortController().signal;
const dns = { resolve: vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]) };
const run = (l = lease(), input = fileInput(), s = signal()) => acquireFile(input, { access: { acquire: async () => l }, dns }, s);
afterEach(() => { vi.useRealTimers(); dns.resolve.mockClear(); });
describe("source policy and SSRF", () => {
    it.each(["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.0.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.2.1", "240.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1", "2001:db8::1", "2606:4700::1111%eth0"])("blocks non-public/special address %s", ip => expect(publicAddress(ip)).toBe(false));
    it("accepts only global unicast, not arbitrary IPv6", () => {
        expect(publicAddress("8.8.8.8")).toBe(true);
        expect(publicAddress("2606:4700:4700::1111")).toBe(true);
        expect(publicAddress("4000::1")).toBe(false);
    });
    it.each(["http://files.example/a", "https://files.example:8443/a", "https://user:secret@files.example/a", "file:///etc/passwd", "https://127.1/a", "https://0x7f000001/a", "https://[::1]/a", "https://files.example./a", "https://files.example.evil/a", "https://evil.example/a", "https://files.example/a#x"])("rejects unsafe URL without network: %s", url => expect(() => permittedUrl(url, ["https://files.example"])).toThrow("SOURCE.ORIGIN_BLOCKED"));
    it("mixed public/private DNS and family mismatch are rejected before connecting", async () => {
        const url = new URL("https://files.example/a");
        for (const answers of [[], [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 6 }]])
            await expect(pinAddress(url, { resolve: async () => answers as Address[] }, signal())).rejects.toThrow("SOURCE.SSRF_BLOCKED");
    });
});
describe("one file acquisition", () => {
    it("proxy file redirects use hostnames without DNS and strip cross-origin credentials", async () => {
        const get = vi.fn(async (_url: URL, _address: Address | undefined, _headers: Readonly<Record<string, string>>) =>
            get.mock.calls.length === 1 ? response(png, { location: "https://cdn.example/image.png" }, 302) : response());
        const base = lease(get), l: SourceLease = { ...base, transport: { ...base.transport, targetResolution: "proxy" } };
        const noDns = { resolve: vi.fn(async () => { throw Error("DNS forbidden"); }) };
        const result = await acquireFile(fileInput(), { access: { acquire: async () => l }, dns: noDns }, signal());
        expect(result.redirects).toBe(1);
        expect(noDns.resolve).not.toHaveBeenCalled();
        expect(get.mock.calls.map(c => [c[0].hostname, c[1]])).toEqual([["files.example", undefined], ["cdn.example", undefined]]);
        expect(get.mock.calls[0]![2].cookie).toContain("canary");
        expect(get.mock.calls[1]![2]).toEqual({});
    });
    it("proxy files still block unapproved and IP-literal redirects before the next connection", async () => {
        for (const location of ["https://evil.example/file", "https://127.0.0.1/file", "http://files.example/file"]) {
            const get = vi.fn(async () => response(png, { location }, 302)), base = lease(get);
            const l: SourceLease = { ...base, transport: { ...base.transport, targetResolution: "proxy" } };
            await expect(run(l)).rejects.toThrow("SOURCE.ORIGIN_BLOCKED");
            expect(get).toHaveBeenCalledTimes(1); expect(dns.resolve).not.toHaveBeenCalled();
        }
    });
    it("detects real image independent of URL extension and returns prepared evidence, not durability", async () => {
        const l = lease(), release = vi.fn(async () => { });
        l.release = release;
        const result = await run(l);
        expect(result).toMatchObject({ file: { sha256: hash(png), byteSize: png.length, kind: "source-image", mediaType: "image/png" }, dimensions: { width: 1, height: 1 }, artifactDurable: false, resultRegistered: false });
        expect(JSON.stringify(result)).not.toContain("canary");
        expect(release).toHaveBeenCalledTimes(1);
    });
    it("rejects batch, extra credentials, version and fingerprint mismatch before session acquisition", async () => {
        const input = fileInput(), acquire = vi.fn(async () => lease());
        for (const field of [{ files: [] }, { url: "https://elsewhere" }, { cookie: "secret" }])
            expect(FileAcquireInputSchema.safeParse({ ...input, ...field }).success).toBe(false);
        for (const bad of [{ ...input, inputFingerprint: "a".repeat(64) }, sign({ ...input, implementationVersion: "2" })])
            await expect(acquireFile(bad, { access: { acquire }, dns }, signal())).rejects.toThrow();
        expect(acquire).not.toHaveBeenCalled();
    });
    it("same-origin redirect keeps credentials; cross-origin allowed CDN strips all source headers", async () => {
        const calls: {
            url: string;
            headers: Readonly<Record<string, string>>;
        }[] = [];
        const l = lease(async (url, _ip, headers) => { calls.push({ url: url.href, headers }); return calls.length === 1 ? response(png, { location: "/step" }, 302) : calls.length === 2 ? response(png, { location: "https://cdn.example/file.jpg" }, 307) : response(); });
        const result = await run(l);
        expect(result.redirects).toBe(2);
        expect(calls[0]!.headers.cookie).toContain("canary");
        expect(calls[1]!.headers.cookie).toContain("canary");
        expect(calls[2]!.headers).toEqual({});
        expect(dns.resolve).toHaveBeenCalledTimes(3);
    });
    it("rejects unapproved/HTTP redirects and private DNS on a later hop without requesting it", async () => {
        for (const location of ["https://evil.example/file", "http://files.example/file"]) {
            const get = vi.fn(async () => response(png, { location }, 302));
            await expect(run(lease(get))).rejects.toThrow("SOURCE.ORIGIN_BLOCKED");
            expect(get).toHaveBeenCalledTimes(1);
        }
        const get = vi.fn(async () => response(png, { location: "/next" }, 302));
        let lookups = 0;
        await expect(acquireFile(fileInput(), { access: { acquire: async () => lease(get) }, dns: { resolve: async () => [{ address: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }] } }, signal())).rejects.toThrow("SOURCE.SSRF_BLOCKED");
        expect(get).toHaveBeenCalledTimes(1);
    });
    it("caps redirect loops, performs no retry, closes responses and releases its own lease", async () => {
        const close = vi.fn(), get = vi.fn(async () => ({ ...response(png, { location: "/loop" }, 302), close })), l = lease(get), release = vi.fn(async () => { });
        l.release = release;
        await expect(run(l)).rejects.toThrow("SOURCE.REDIRECT_LIMIT");
        expect(get).toHaveBeenCalledTimes(4);
        expect(close).toHaveBeenCalledTimes(4);
        expect(release).toHaveBeenCalledTimes(1);
    });
    it("requires exact source/session/resource/egress binding", async () => {
        for (const patch of [{ sourceId: "other" }, { resourceId: "other" }, { binding: { sessionId: "other", egressId: "direct/1" } }, { binding: { sessionId: "session-1", egressId: "clash/1" } }]) {
            const get = vi.fn(async () => response());
            await expect(run({ ...lease(get), ...patch })).rejects.toThrow("SOURCE.SESSION_MISMATCH");
            expect(get).not.toHaveBeenCalled();
        }
    });
    it("cannot complete if the session/egress changes during a response", async () => {
        const l = lease();
        l.transport.get = async () => ({ ...response(), body: (async function* () { yield png.subarray(0, 20); l.binding.egressId = "changed"; yield png.subarray(20); })() });
        await expect(run(l)).rejects.toThrow("SOURCE.SESSION_MISMATCH");
    });
    it("rejects reuse of another observation, listing or variant before any network access", async () => {
        for (const field of ["requestId", "observationId", "brandId", "listingId", "variantId"] as const) {
            const l = lease(), get = vi.fn(l.transport.get);
            l.transport.get = get;
            l.owner[field] = "other";
            await expect(run(l)).rejects.toThrow("SOURCE.SESSION_MISMATCH");
            expect(get).not.toHaveBeenCalled();
        }
    });
    it.each([401, 403, 404, 429, 500, 206])("HTTP %s is not retried", async (status) => {
        const get = vi.fn(async () => response(png, {}, status));
        await expect(run(lease(get))).rejects.toThrow("SOURCE.HTTP_STATUS");
        expect(get).toHaveBeenCalledTimes(1);
    });
    it("rejects oversized declared/streamed bytes, gzip, mismatched length and wrong hashes", async () => {
        for (const headers of [{ "content-length": String(FILE_POLICY.maxBytes + 1) }, { "content-encoding": "gzip" }, { "content-length": "1" }])
            await expect(run(lease(async () => response(png, headers)))).rejects.toThrow();
        const streamed = { ...response(), body: (async function* () { const chunk = Buffer.alloc(1024 * 1024); for (let i = 0; i < 33; i++)
                yield chunk; })() };
        await expect(run(lease(async () => streamed))).rejects.toThrow("ARTIFACT.TOO_LARGE");
        await expect(run(lease(), sign({ ...fileInput(), expectedSha256: "1".repeat(64) }))).rejects.toThrow("ARTIFACT.INTEGRITY");
    });
    it("rejects HTML disguised as an image, MIME conflicts, truncated files and unsafe headers", async () => {
        await expect(run(lease(async () => response(Buffer.from("<html>login</html>"))))).rejects.toThrow("ARTIFACT.MEDIA_TYPE");
        await expect(run(lease(async () => response(png, { "content-type": "image/jpeg" })))).rejects.toThrow("ARTIFACT.MEDIA_TYPE");
        await expect(run(lease(async () => response(png.subarray(0, 24))))).rejects.toThrow("ARTIFACT.INTEGRITY");
        const l = lease();
        l.headersFor = () => ({ Host: "169.254.169.254" });
        await expect(run(l)).rejects.toThrow("SOURCE.SESSION_MISMATCH");
    });
    it("abort closes stalled streams and never starts when pre-aborted", async () => {
        const controller = new AbortController(), close = vi.fn(), l = lease(async () => ({ ...response(), close, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => { }) }) } }));
        const pending = run(l, fileInput(), controller.signal);
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
        await expect(pending).rejects.toThrow();
        expect(close).toHaveBeenCalled();
        const get = vi.fn(async () => response());
        await expect(run(lease(get), fileInput(), controller.signal)).rejects.toThrow();
        expect(get).not.toHaveBeenCalled();
    });
    it("bounds hung DNS with the whole-operation deadline and releases the lease", async () => {
        vi.useFakeTimers();
        const l = lease(), release = vi.fn(async () => { });
        l.release = release;
        const pending = acquireFile(fileInput(), { access: { acquire: async () => l }, dns: { resolve: () => new Promise(() => { }) } }, signal());
        const assertion = expect(pending).rejects.toThrow("SOURCE.NETWORK_UNAVAILABLE");
        await vi.advanceTimersByTimeAsync(FILE_POLICY.timeoutMs + 1);
        await assertion;
        expect(release).toHaveBeenCalledTimes(1);
    });
    it("release failure cannot claim success or mask an original security failure", async () => {
        const l = lease();
        l.release = async () => { throw Error("secret"); };
        await expect(run(l)).rejects.toThrow("SOURCE.SESSION_UNAVAILABLE");
        l.assertActive = () => { throw new AcquisitionError("SOURCE.SESSION_MISMATCH"); };
        await expect(run(l)).rejects.toThrow("SOURCE.SESSION_MISMATCH");
    });
    it("independent files can overlap without a global queue or shared session mutation", async () => {
        let active = 0, peak = 0;
        const leases: SourceLease[] = [];
        const acquire = async (input: ReturnType<typeof fileInput>) => { const l = { ...lease(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setImmediate(r)); active--; return response(); }), binding: { ...input.binding }, resourceId: input.resourceId }; leases.push(l); return l; };
        await Promise.all(Array.from({ length: 3 }, (_, i) => acquireFile(sign({ ...fileInput(), operationId: `op-${i}`, binding: { sessionId: `session-${i}`, egressId: "direct/1" } }), { access: { acquire }, dns }, signal())));
        expect(peak).toBe(3);
        expect(leases.length).toBe(3);
    });
});
