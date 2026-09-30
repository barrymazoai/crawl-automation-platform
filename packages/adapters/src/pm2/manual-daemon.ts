import { pm2Errors } from "./pm2-errors.js";

interface DaemonClient {
  daemon_mode: boolean;
  launchDaemon(callback: (error: Error) => void): void;
}

/**
 * PM2 7.0.4 connect() has no attach-only option: even after a socket preflight it can spawn if
 * the daemon exits. Block that fallback on this client. An incompatible PM2 fails closed.
 * All process operations still go through PM2's programmatic API.
 */
export function forbidDaemonLaunch(api: { Client?: DaemonClient }): void {
  const client = api.Client;
  if (!client || client.daemon_mode !== true || typeof client.launchDaemon !== "function") {
    throw pm2Errors.create("PM2.ATTACH_UNSUPPORTED");
  }
  client.launchDaemon = (callback) => callback(pm2Errors.create("PM2.DAEMON_REQUIRED"));
}
