import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { fileErrors } from "./file-errors.js";
import type { Address, DnsResolver, FileTransport } from "./file-ports.js";

export function publicAddress(raw: string): boolean {
  if (!isIP(raw) || raw.includes("%")) {
    return false;
  }
  const address = ipaddr.parse(raw);
  return (
    address.range() === "unicast" &&
    (address.kind() === "ipv4" || address.match(ipaddr.parse("2000::"), 3))
  );
}

/**
 * An allowed-origins entry that admits any public HTTPS host (owner 2026-10-08: DTC product images may sit on any
 * image server, e.g. PureTrim's cdn.awccloud.com). HTTPS, no credentials, port or IP literal, and the public-address
 * pin still apply.
 */
export const ANY_HTTPS_ORIGIN = "https://*";

export function permittedUrl(raw: string, allowedOrigins: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw fileErrors.create("SOURCE.ORIGIN_BLOCKED", { cause });
  }
  const unsafe = [
    url.protocol !== "https:",
    url.username,
    url.password,
    url.hash,
    url.port,
    url.hostname.endsWith("."),
    isIP(url.hostname.replace(/^\[|\]$/g, "")),
    !allowedOrigins.includes(url.origin) && !allowedOrigins.includes(ANY_HTTPS_ORIGIN),
  ];
  if (unsafe.some(Boolean)) {
    throw fileErrors.create("SOURCE.ORIGIN_BLOCKED");
  }
  return url;
}

export const systemDns: DnsResolver = {
  async resolve(hostname, signal) {
    signal.throwIfAborted();
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    signal.throwIfAborted();
    return addresses.map((address) => ({ ...address, family: address.family as 4 | 6 }));
  },
};

export async function pinAddress(
  url: URL,
  dns: DnsResolver,
  signal: AbortSignal,
): Promise<Address> {
  let answers: Address[];
  try {
    answers = await dns.resolve(url.hostname, signal);
  } catch (cause) {
    signal.throwIfAborted();
    throw fileErrors.create("SOURCE.NETWORK_UNAVAILABLE", { cause });
  }
  signal.throwIfAborted();
  const first = answers[0];
  if (
    !first ||
    answers.some(
      (answer) => !publicAddress(answer.address) || isIP(answer.address) !== answer.family,
    )
  ) {
    throw fileErrors.create("SOURCE.SSRF_BLOCKED");
  }
  return first;
}

/** The trusted transport chooses resolution, never task input or a DNS-failure fallback. */
export async function transportAddress(
  request: { url: URL; transport: FileTransport; dns: DnsResolver },
  signal: AbortSignal,
): Promise<Address | undefined> {
  signal.throwIfAborted();
  if (["proxy", "browser", "system"].includes(request.transport.targetResolution ?? "")) {
    return undefined;
  }
  return pinAddress(request.url, request.dns, signal);
}
