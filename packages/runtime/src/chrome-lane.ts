import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

type SpawnChrome = (executable: string, args: string[]) => ChildProcessWithoutNullStreams;

export type ChromeLane = {
  id: number;
  cdpUrl: string;
  profileDirectory: string;
  executable: string;
  health(): Promise<boolean>;
  close(): Promise<void>;
};

export function chromeExecutableCandidates(platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform === "win32") {
    return [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    ].filter((value): value is string => Boolean(value));
  }
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

export async function resolveChromeExecutable(explicit?: string, options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  access?: typeof fs.access;
} = {}) {
  const access = options.access ?? fs.access;
  const candidates = [
    ...(explicit ? [path.resolve(explicit)] : []),
    ...chromeExecutableCandidates(options.platform, options.env),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next well-known installation path.
    }
  }
  throw new Error(`chrome_executable_not_found:${candidates.join("|")}`);
}

export async function allocateLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForCdp(cdpUrl: string, input: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  child: ChildProcessWithoutNullStreams;
  stderr: string[];
}) {
  const deadline = Date.now() + input.timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (input.child.exitCode !== null) {
      throw new Error(`chrome_exited_before_cdp:code=${input.child.exitCode}:${input.stderr.join(" | ")}`);
    }
    try {
      const response = await input.fetchImpl(`${cdpUrl}/json/version`);
      if (response.ok) {
        const version = await response.json() as { webSocketDebuggerUrl?: string };
        if (version.webSocketDebuggerUrl) return version;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`chrome_cdp_not_ready:${lastError}:${input.stderr.join(" | ")}`);
}

async function stopChrome(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function startChromeLane(options: {
  id: number;
  profileRoot: string;
  executablePath?: string;
  headless?: boolean;
  startupTimeoutMs?: number;
  port?: number;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnChrome;
  preflight?: (cdpUrl: string) => Promise<void>;
  resolveExecutable?: typeof resolveChromeExecutable;
  allocatePort?: typeof allocateLoopbackPort;
}): Promise<ChromeLane> {
  const executable = await (options.resolveExecutable ?? resolveChromeExecutable)(options.executablePath);
  const port = options.port ?? await (options.allocatePort ?? allocateLoopbackPort)();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const profileDirectory = path.resolve(options.profileRoot, `lane-${options.id}`);
  await fs.mkdir(profileDirectory, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--disable-component-update",
    "about:blank",
  ];
  if (options.headless) args.unshift("--headless=new", "--disable-gpu");
  const child = (options.spawnImpl ?? ((command, commandArgs) => spawn(command, commandArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  })))(executable, args);
  const fetchImpl = options.fetchImpl ?? fetch;
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk).trim());
    while (stderr.length > 20) stderr.shift();
  });

  try {
    await waitForCdp(cdpUrl, {
      fetchImpl,
      timeoutMs: options.startupTimeoutMs ?? 20_000,
      child,
      stderr,
    });
    await options.preflight?.(cdpUrl);
  } catch (error) {
    await stopChrome(child);
    throw error;
  }

  return {
    id: options.id,
    cdpUrl,
    profileDirectory,
    executable,
    async health() {
      if (child.exitCode !== null) return false;
      try {
        const response = await fetchImpl(`${cdpUrl}/json/version`);
        if (!response.ok) return false;
        const version = await response.json() as { webSocketDebuggerUrl?: string };
        return Boolean(version.webSocketDebuggerUrl);
      } catch {
        return false;
      }
    },
    close: () => stopChrome(child),
  };
}
