import { describe, expect, it, vi } from "vitest";
import { forbidDaemonLaunch } from "./manual-daemon.js";
import { pm2Call } from "./pm2-client.js";

describe("manual PM2 daemon", () => {
  it("blocks PM2's launch fallback if the daemon exits between preflight and connect", async () => {
    const launch = vi.fn();
    const client = { daemon_mode: true, launchDaemon: launch };
    forbidDaemonLaunch({ Client: client });
    await expect(
      pm2Call("connect", (callback) => client.launchDaemon(callback)),
    ).rejects.toMatchObject({
      code: "PM2.OPERATION_FAILED",
      cause: { code: "PM2.DAEMON_REQUIRED" },
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("fails closed on an incompatible client or PM2's in-process daemon mode", () => {
    expect(() => forbidDaemonLaunch({})).toThrow(
      expect.objectContaining({ code: "PM2.ATTACH_UNSUPPORTED" }),
    );
    expect(() =>
      forbidDaemonLaunch({ Client: { daemon_mode: false, launchDaemon: vi.fn() } }),
    ).toThrow(expect.objectContaining({ code: "PM2.ATTACH_UNSUPPORTED" }));
  });
});
