import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { mkdtemp, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FileCopies, ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { DirectHttpsTransport } from "../src/network.js";
import { acquireFile } from "../src/file.js";
import { fileInput, lease, png } from "../src/testing.fixture.js";
// Test-only socket redirection. Production still validates and pins public DNS.
// Keep original hostname/SNI/certificate verification while dialing a local TLS fixture.
const fixture = vi.hoisted(() => ({ port: 0, ca: Buffer.alloc(0), trust: true, pins: [] as string[], options: [] as {
        family: unknown;
        servername: unknown;
        agent: unknown;
        verify: unknown;
    }[] }));
vi.mock("node:https", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:https")>();
    return { ...actual, request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
            options.lookup!(url.hostname, {}, (_error, ip) => { fixture.pins.push(String(ip)); });
            fixture.options.push({ family: options.family, servername: options.servername, agent: options.agent, verify: options.rejectUnauthorized });
            const target = new URL(url);
            target.port = String(fixture.port);
            return actual.request(target, { ...options, ...(fixture.trust ? { ca: fixture.ca } : {}), lookup: (_host, _options, cb) => cb(null, "127.0.0.1", 4) }, callback);
        } };
});
import { createServer } from "node:https";
let root: string, server: ReturnType<typeof createServer>;
let requests: {
    host: string;
    path: string;
    cookie: string | undefined;
    encoding: string | undefined;
}[] = [];
beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "v3-acquisition-"));
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1", "-subj", "/CN=files.example", "-addext", "subjectAltName=DNS:files.example,DNS:cdn.example"]);
    await chmod(join(root, "key.pem"), 0o600);
    fixture.ca = await readFile(join(root, "cert.pem"));
    server = createServer({ key: await readFile(join(root, "key.pem")), cert: fixture.ca }, (req, res) => {
        requests.push({ host: req.headers.host ?? "", path: req.url ?? "", cookie: req.headers.cookie, encoding: req.headers["accept-encoding"] });
        if (req.url === "/redirect") {
            res.writeHead(302, { location: "https://cdn.example/file" });
            res.end();
            return;
        }
        if (req.url === "/deny") {
            res.writeHead(403);
            res.end("denied");
            return;
        }
        if (req.url === "/broken") {
            res.writeHead(200, { "content-type": "image/png", "content-length": png.length + 10 });
            res.write(png);
            setImmediate(() => res.destroy());
            return;
        }
        res.writeHead(200, { "content-type": "image/png" });
        res.write(png.subarray(0, 20));
        setImmediate(() => res.end(png.subarray(20)));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
        throw Error("Missing port");
    fixture.port = address.port;
});
afterAll(async () => {
    server?.closeAllConnections();
    if (server)
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
    console.log("Stopped isolated HTTPS fixture; evidence retained:", root);
});
const signal = () => new AbortController().signal;
const run = async (path: string) => {
    const l = { ...lease(), url: `https://files.example${path}`, transport: new DirectHttpsTransport() };
    return acquireFile(fileInput(), { access: { acquire: async () => l }, dns: { resolve: async () => [{ address: "8.8.8.8", family: 4 }] } }, signal());
};
describe.sequential("actual local HTTPS through test-only dial redirection", () => {
    it("real TLS/chunked response honors pinned lookup, verified SNI and cross-origin cookie stripping", async () => {
        requests = [];
        vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
        vi.stubEnv("ALL_PROXY", "http://127.0.0.1:1");
        const result = await run("/redirect");
        expect(result.bytes).toEqual(png);
        expect(result.redirects).toBe(1);
        expect(requests).toHaveLength(2);
        expect(requests[0]!.cookie).toContain("canary");
        expect(requests[1]!.cookie).toBeUndefined();
        expect(requests.every(r => r.encoding === "identity")).toBe(true);
        expect(fixture.pins).toEqual(["8.8.8.8", "8.8.8.8"]);
        expect(fixture.options).toEqual([
            { family: 4, servername: "files.example", agent: false, verify: true }, { family: 4, servername: "cdn.example", agent: false, verify: true }
        ]);
    });
    it("untrusted TLS certificate fails closed and performs no HTTP request", async () => {
        const count = requests.length;
        fixture.trust = false;
        try {
            await expect(run("/file")).rejects.toThrow("SOURCE.NETWORK_UNAVAILABLE");
        }
        finally {
            fixture.trust = true;
        }
        expect(requests.length).toBe(count);
    });
    it("HTTP rejection and truncated socket are failures, never retry", async () => {
        let count = requests.length;
        await expect(run("/deny")).rejects.toThrow("SOURCE.HTTP_STATUS");
        expect(requests.length - count).toBe(1);
        count = requests.length;
        await expect(run("/broken")).rejects.toThrow();
        expect(requests.length - count).toBe(1);
    });
    it("transport independently rejects private pins before the test socket shim", async () => {
        const count = fixture.options.length;
        await expect(new DirectHttpsTransport().get(new URL("https://files.example/file"), { address: "127.0.0.1", family: 4 }, {}, signal())).rejects.toThrow("SOURCE.SSRF_BLOCKED");
        expect(fixture.options.length).toBe(count);
    });
    it("prepared source evidence can pass existing artifact publication without pretending result registration", async () => {
        const result = await run("/file"), local = await FileCopies.open(join(root, "cache"));
        const objects = new Map<string, Uint8Array>();
        const resolver = new ArtifactResolver(local, { read: async (key) => objects.get(key) ?? null, create: async (key, bytes) => { if (objects.has(key))
                return "exists"; objects.set(key, bytes); return "created"; } });
        const i = result.input, owner = { schemaVersion: 1 as const, requestId: i.requestId, observationId: i.observationId, brandId: i.brandId, sourceId: i.sourceId, listingId: i.listingId, variantId: i.variantId };
        expect(await resolver.publish(result.file, owner, result.bytes, signal())).toMatchObject({ durable: true });
        expect(await resolver.resolve(result.file, owner, signal())).toMatchObject({ from: "local" });
        expect(result.resultRegistered).toBe(false);
    });
});
