import { expect, it } from "vitest";
import { dohDns, pinAddress } from "./network.js";
const signal = () => new AbortController().signal;
const fetchWith = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
it("resolves public IPv4 answers over DoH and the SSRF guard still pins them", async () => {
  const dns = dohDns("https://cloudflare-dns.com/dns-query", fetchWith({ Status: 0, Answer: [{ type: 5, data: "cdn.example." }, { type: 1, data: "13.32.10.5" }, { type: 1, data: "13.32.10.6" }] }));
  expect(await dns.resolve("m.media-amazon.com", signal())).toEqual([{ address: "13.32.10.5", family: 4 }, { address: "13.32.10.6", family: 4 }]);
  expect(await pinAddress(new URL("https://m.media-amazon.com/images/I/x.jpg"), dns, signal())).toEqual({ address: "13.32.10.5", family: 4 });
});
it("fake or private answers are still refused; failures and empty answers are network errors", async () => {
  const fake = dohDns("https://cloudflare-dns.com/dns-query", fetchWith({ Status: 0, Answer: [{ type: 1, data: "198.18.0.247" }] }));
  await expect(pinAddress(new URL("https://m.media-amazon.com/x"), fake, signal())).rejects.toMatchObject({ code: "SOURCE.SSRF_BLOCKED" });
  await expect(dohDns("https://cloudflare-dns.com/dns-query", fetchWith({ Status: 3 })).resolve("nx.example", signal())).rejects.toMatchObject({ code: "SOURCE.NETWORK_UNAVAILABLE" });
  await expect(dohDns("https://cloudflare-dns.com/dns-query", fetchWith({}, false)).resolve("x.example", signal())).rejects.toMatchObject({ code: "SOURCE.NETWORK_UNAVAILABLE" });
  await expect(dohDns("https://cloudflare-dns.com/dns-query", fetchWith({ Status: 0, Answer: [{ type: 28, data: "2600::1" }] })).resolve("v6.example", signal())).rejects.toMatchObject({ code: "SOURCE.NETWORK_UNAVAILABLE" });
});
