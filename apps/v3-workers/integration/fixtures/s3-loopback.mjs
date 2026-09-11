// Explicit --import for this test child ONLY. Never included in a business build.
// Keep TLS verification and the SDK intact; map the one fake R2 origin to our TLS simulator.
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
const host = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com";
const port = Number(process.env.V3_TEST_S3_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid isolated S3 port");
const original = https.request;
https.request = function (options, callback) {
  if (!options || typeof options !== "object" || (options.hostname ?? options.host) !== host) throw Error("Test HTTPS egress denied");
  return original.call(this, { ...options, port, servername: host,
    lookup: (_name, options, done) => options?.all
      ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }, callback);
};
syncBuiltinESMExports();
