// Isolated test preload only: public DNS pin/SNI verification remain visible to production code.
import https from "node:https";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
const r2Host = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", sourceHost = "files.example";
const port = Number(process.env.V3_TEST_S3_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid isolated port");
dns.lookup = async hostname => { if (hostname !== sourceHost) throw Error("Test DNS denied"); return [{ address: "8.8.8.8", family: 4 }]; };
const request = https.request;
https.request = function (urlOrOptions, optionsOrCallback, callback) {
  if (urlOrOptions instanceof URL) {
    if (urlOrOptions.hostname !== sourceHost || optionsOrCallback.rejectUnauthorized !== true || optionsOrCallback.servername !== sourceHost) throw Error("Test source egress denied");
    let pin;
    optionsOrCallback.lookup(sourceHost, {}, (_error, address) => { pin = address; });
    if (pin !== "8.8.8.8") throw Error("Missing public pin");
    const target = new URL(urlOrOptions); target.port = String(port);
    return request.call(this, target, { ...optionsOrCallback, lookup: (_host, _options, cb) => cb(null, "127.0.0.1", 4) }, callback);
  }
  if ((urlOrOptions?.hostname ?? urlOrOptions?.host) !== r2Host) throw Error("Test R2 egress denied");
  return request.call(this, { ...urlOrOptions, port, servername: r2Host,
    lookup: (_name, options, cb) => options?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4) }, optionsOrCallback);
};
syncBuiltinESMExports();
