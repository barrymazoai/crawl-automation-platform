import {mkdir,copyFile,mkdtemp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,isAbsolute,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
assert.equal(process.platform,'darwin');
const [destination,...extra]=process.argv.slice(2);
assert.equal(extra.length,0);
assert.ok(destination && isAbsolute(destination) && basename(destination)==='Crawler Mouse.app');
// Refuse overwrite, including an existing symlink or an already-authorized app.
await mkdir(destination,{mode:0o755});
await mkdir(join(destination,'Contents','MacOS'),{recursive:true});
await copyFile(fileURLToPath(new URL('./crawler-mouse-Info.plist',import.meta.url)),join(destination,'Contents','Info.plist'));
const cache=await mkdtemp(join(tmpdir(),'crawler-mouse-swift-'));
execFileSync('/usr/bin/xcrun',['swiftc','-module-cache-path',cache,
  fileURLToPath(new URL('./native-mouse-hold.swift',import.meta.url)),
  '-o',join(destination,'Contents','MacOS','CrawlerMouse')],{stdio:'inherit'});
execFileSync('/usr/bin/plutil',['-lint',join(destination,'Contents','Info.plist')],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--sign','-','--identifier','net.supplysmart.crawler-mouse',destination],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--verify','--strict',destination],{stdio:'inherit'});
execFileSync(join(destination,'Contents','MacOS','CrawlerMouse'),['--self-test'],{stdio:'inherit'});
console.log(JSON.stringify({app:destination,bundleIdentifier:'net.supplysmart.crawler-mouse',signed:'ad-hoc',launched:false}));
