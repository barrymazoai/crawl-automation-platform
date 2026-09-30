// Explicit one-time install; no crash loop, no credentials in plist, no task replay.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const [manifestPath] = process.argv.slice(2);
assert.equal(process.platform, 'darwin');
assert.match(manifestPath, /^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+\/live\/deployment.json$/);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.host, hostname());
await assert.rejects(lstat(join(manifest.root, 'supervisor.lock')), { code: 'ENOENT' });
const label = 'com.crawlv3.batch-a', folder = join(homedir(), 'Library/LaunchAgents');
const plist = join(folder, `${label}.plist`), entry = join(dirname(manifest.jobs[0].entry), 'deployment-supervisor.js');
assert.ok((await lstat(entry)).isFile());
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await mkdir(folder, { recursive: true });
for (const name of ['launchd.stdout.log', 'launchd.stderr.log']) await writeFile(join(manifest.root, name), '', { flag: 'ax', mode: 0o600 });
await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[manifest.node, entry, manifestPath].map(s => `<string>${xml(s)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(manifest.root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>45</integer>
<key>StandardOutPath</key><string>${xml(join(manifest.root, 'launchd.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(manifest.root, 'launchd.stderr.log'))}</string>
</dict></plist>`, { flag: 'wx', mode: 0o600 });
await promisify(execFile)('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
console.log(JSON.stringify({ installed: true, label, plist, crashAutoRestart: false, launchAtLogin: true }));
