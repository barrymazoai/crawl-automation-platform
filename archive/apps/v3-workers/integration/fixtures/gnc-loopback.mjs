// Test-only dial redirection and synthetic browser. Never included in production builds.
import "./gnc-browser-cdp.mjs";
import https from "node:https";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
const sourceHost = "www.gnc.com", r2Host = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com";
const port = Number(process.env.V3_TEST_S3_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid isolated port");
dns.lookup = async hostname => { if (hostname !== sourceHost) throw Error("Test DNS denied"); return [{ address: "8.8.8.8", family: 4 }]; };
const request = https.request;
https.request = function (urlOrOptions, optionsOrCallback, callback) {
  if (urlOrOptions instanceof URL) {
    // Proxy transport has already established a verified TLS tunnel to the fixture CONNECT server.
    if (optionsOrCallback.agent && optionsOrCallback.agent !== false) {
      if (process.env.V3_TEST_DENY_SOURCE === "true" || urlOrOptions.hostname !== sourceHost || optionsOrCallback.rejectUnauthorized !== true) throw Error("Test proxy source denied");
      return request.call(this, urlOrOptions, optionsOrCallback, callback);
    }
    if (process.env.V3_TEST_DENY_SOURCE === "true" || urlOrOptions.hostname !== sourceHost || optionsOrCallback.rejectUnauthorized !== true || optionsOrCallback.servername !== sourceHost) throw Error("Test source denied");
    let pin;
    optionsOrCallback.lookup(sourceHost, {}, (_error, address) => { pin = address; });
    if (pin !== "8.8.8.8") throw Error("Missing public pin");
    const target = new URL(urlOrOptions); target.port = String(port);
    return request.call(this, target, { ...optionsOrCallback, lookup: (_host, _options, cb) => cb(null, "127.0.0.1", 4) }, callback);
  }
  if ((urlOrOptions?.hostname ?? urlOrOptions?.host) !== r2Host) throw Error("Test R2 denied");
  return request.call(this, { ...urlOrOptions, port, servername: r2Host,
    lookup: (_name, options, cb) => options?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4) }, optionsOrCallback);
};
syncBuiltinESMExports();
