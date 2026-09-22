// Explicit operator controls. These plists live in the project, never LaunchAgents.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const [root, command, target = 'all'] = process.argv.slice(2);
const names = ['health', 'queue', 'janitor'];
if (process.platform !== 'darwin' || !root || !path.isAbsolute(root) ||
    !['start', 'stop', 'status'].includes(command) || !['all', ...names].includes(target)) {
  throw Error('Usage: manual-maintenance <project-root> start|stop|status [all|health|queue|janitor]');
}
const run = (binary, args) => spawnSync(binary, args, {encoding: 'utf8', timeout: 15000});
const selected = target === 'all' ? names : [target];
for (const name of command === 'stop' ? [...selected].reverse() : selected) {
  const label = 'com.crawlv3.maintenance.promises.' + name;
  const service = 'gui/' + process.getuid() + '/' + label;
  const file = path.join(root, 'manual-services', label + '.plist');
  if (fs.realpathSync(file) !== file || fs.lstatSync(file).isSymbolicLink()) throw Error('MAINTENANCE.PLATFORM_PATH');
  const parsed = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  if (parsed.status !== 0) throw Error('MAINTENANCE.PLIST_INVALID');
  const config = JSON.parse(parsed.stdout);
  if (config.Label !== label || config.RunAtLoad !== false || config.KeepAlive !== false) throw Error('MAINTENANCE.MANUAL_ONLY');
  const before = run('/bin/launchctl', ['print', service]);
  if (command === 'start') {
    if (before.status !== 0 && run('/bin/launchctl', ['bootstrap', 'gui/' + process.getuid(), file]).status !== 0) throw Error('MAINTENANCE.LOAD_FAILED');
    if (run('/bin/launchctl', ['kickstart', service]).status !== 0) throw Error('MAINTENANCE.START_FAILED');
  } else if (command === 'stop' && before.status === 0) {
    if (run('/bin/launchctl', ['bootout', service]).status !== 0) throw Error('MAINTENANCE.STOP_FAILED');
  }
  const after = run('/bin/launchctl', ['print', service]);
  if (command === 'stop' && after.status === 0) throw Error('MAINTENANCE.STOP_UNCONFIRMED');
  console.log(JSON.stringify({name, loaded: after.status === 0,
    state: /\n\s*state = ([^\n]+)/.exec(after.stdout)?.[1] ?? 'unloaded',
    pid: Number(/\n\s*pid = (\d+)/.exec(after.stdout)?.[1]) || null,
    bootOrLoginInstalled: false}));
}
