import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { fileErrors } from "./file-errors.js";
import { permittedUrl, publicAddress } from "./file-network.js";
import type { FileTransport, Response } from "./file-ports.js";

function getResponse(url: URL, options: RequestOptions): Promise<Response> {
  permittedUrl(url.href, [url.origin]);
  return new Promise((resolve, reject) => {
    const pending = request(
      url,
      {
        ...options,
        method: "GET",
        agent: false,
        maxHeaderSize: 16 * 1024,
        servername: url.hostname,
        rejectUnauthorized: true,
      },
      (response) => {
        const headers: Response["headers"] = {};
        for (const name of ["content-type", "content-length", "content-encoding", "location"]) {
          const value = response.headers[name];
          headers[name] = Array.isArray(value) ? value.join(",") : value;
        }
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: response,
          close: () => {
            response.destroy();
          },
        });
      },
    );
    pending.on("error", (cause) =>
      reject(fileErrors.create("SOURCE.NETWORK_UNAVAILABLE", { cause })),
    );
    pending.end();
  });
}

/** One pinned HTTPS GET. No redirects, proxy-environment fallback, or retries. */
export class DirectHttpsTransport implements FileTransport {
  readonly egressId = "direct/1";
  readonly targetResolution = "local-pinned" as const;
  get: FileTransport["get"] = async (...[url, address, headers, signal]) => {
    permittedUrl(url.href, [url.origin]);
    if (!address || !publicAddress(address.address) || isIP(address.address) !== address.family) {
      throw fileErrors.create("SOURCE.SSRF_BLOCKED");
    }
    return getResponse(url, {
      signal,
      family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { ...headers, "accept-encoding": "identity" },
    });
  };
}

/** Operator-selected host/TUN resolution for trusted channel CDNs; the same host egress as direct. */
export class SystemHttpsTransport implements FileTransport {
  readonly egressId = "direct/1";
  readonly targetResolution = "system" as const;
  get: FileTransport["get"] = async (...[url, _address, headers, signal]) =>
    getResponse(url, { signal, headers: { ...headers, "accept-encoding": "identity" } });
}
