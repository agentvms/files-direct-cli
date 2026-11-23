// The Files Direct app, built for one system (files-direct-34). Run by .github/workflows/desktop-app.yml on a GitHub-hosted machine of that system:
//   node scripts/app-build.mjs <mac-arm64 | mac-x64 | win-x64> [size]
// The app is the program's own engine (one file built from the same source as the command-line program), the Node it runs on (the official build,
// checked against a fixed SHA-256), and the one native file the connection library needs for this system. Nothing is downloaded but Node.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

export const NODE_VERSION = '22.23.5';
/** Official Node archives (https://nodejs.org/dist/v<version>/SHASUMS256.txt) and the SHA-256 each one must have. */
export const TARGETS = {
  'mac-arm64': { os: 'darwin', archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d', native: '@node-datachannel/darwin-arm64', binary: 'bin/node' },
  'mac-x64': { os: 'darwin', archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422', native: '@node-datachannel/darwin-x64', binary: 'bin/node' },
  'win-x64': { os: 'win32', archive: `node-v${NODE_VERSION}-win-x64.zip`, sha256: '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3', native: '@node-datachannel/win32-x64-msvc', binary: 'node.exe' },
  // only for trying this script on a Linux machine; no app is made for it
  'linux-arm64': { os: 'linux', archive: `node-v${NODE_VERSION}-linux-arm64.tar.xz`, sha256: '2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09', native: '@node-datachannel/linux-arm64-gnu', binary: 'bin/node' },
};

const sh = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o });
  if (r.status !== 0) throw new Error(cmd + ' ' + args.join(' ') + ' failed (' + r.status + '): ' + (r.stderr || r.stdout || r.error));
  return r.stdout;
};
const sizeOf = (p) => {
  const s = statSync(p);
  return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + sizeOf(join(p, f)), 0) : s.size;
};
const mb = (n) => (n / 1e6).toFixed(1) + ' MB';

/** The Node binary of the official archive, after its SHA-256 matched the fixed one. */
export async function fetchNode(target, dir) {
  const t = TARGETS[target];
  const file = join(dir, t.archive);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const res = await fetch('https://nodejs.org/dist/v' + NODE_VERSION + '/' + t.archive);
    if (!res.ok) throw new Error('nodejs.org answered ' + res.status + ' for ' + t.archive);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (sha !== t.sha256) throw new Error(t.archive + ' has SHA-256 ' + sha + ', not the fixed ' + t.sha256);
  const out = join(dir, 'unpacked-' + target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  sh('tar', ['-xf', file, '-C', out, '--strip-components=1']);
  return { node: join(out, t.binary), license: join(out, 'LICENSE'), archiveBytes: statSync(file).size };
}

/** The engine as one file: the same source as the command-line program, with the connection library's loader left out (it is shipped beside it). */
export async function buildEngine(outfile) {
  const entry = existsSync('src/cli/src/main.ts') ? 'src/cli/src/main.ts' : 'cli/src/main.ts';
  const pkg = JSON.parse(readFileSync(existsSync('src/cli/src/main.ts') ? 'package.json' : 'cli/package.json', 'utf8'));
  const origin = process.env.FD_BUILD_ORIGIN ?? (existsSync('site.json') ? JSON.parse(readFileSync('site.json', 'utf8')).origin : /^SITE_ORIGIN = "([^"]+)"$/m.exec(readFileSync('wrangler.toml', 'utf8'))?.[1]);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: false,
    legalComments: 'none',
    external: ['node-datachannel', 'node-datachannel/polyfill'],
    banner: { js: "import { createRequire as __fdRequire } from 'node:module'; const require = __fdRequire(import.meta.url);" },
    define: { __FD_VERSION__: JSON.stringify(pkg.version), __FD_ORIGIN__: JSON.stringify(origin) },
    logLevel: 'warning',
  });
  return { version: pkg.version, origin };
}

/** node_modules for the engine: the connection library, the one native file of this system, and the one package the loader needs. */
export function copyNative(target, into) {
  const t = TARGETS[target];
  const from = (...p) => join('node_modules', ...p);
  const keep = (src, dst, filter) => cpSync(src, dst, { recursive: true, filter });
  keep(from('node-datachannel', 'package.json'), join(into, 'node_modules', 'node-datachannel', 'package.json'));
  keep(from('node-datachannel', 'dist', 'esm'), join(into, 'node_modules', 'node-datachannel', 'dist', 'esm'), (s) => !s.endsWith('.map'));
  keep(from('node-datachannel', 'LICENSE'), join(into, 'node_modules', 'node-datachannel', 'LICENSE'));
  keep(from('detect-libc'), join(into, 'node_modules', 'detect-libc'));
  keep(from(...t.native.split('/')), join(into, 'node_modules', ...t.native.split('/')));
}

const ITEMS = [];
const note = (what, bytes, extra = '') => {
  ITEMS.push({ what, bytes });
  console.log('size    ' + what.padEnd(58) + String(bytes).padStart(11) + ' bytes  ' + mb(bytes).padStart(9) + (extra ? '  ' + extra : ''));
};

/** Every way of packing the bare app that is worth a number, for the size spike. */
function packOptions(target, stage, work) {
  const t = TARGETS[target];
  if (t.os === 'darwin') {
    const app = join(stage, 'Files Direct.app');
    note('app folder, as installed', sizeOf(app));
    const zip = join(work, 'app.zip');
    sh('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
    note('.zip (ditto)', statSync(zip).size);
    const txz = join(work, 'app.tar.xz');
    sh('tar', ['-cJf', txz, '-C', stage, 'Files Direct.app'], { env: { ...process.env, XZ_OPT: '-9e' } });
    note('.tar.xz (xz -9e)', statSync(txz).size);
    for (const fmt of ['UDZO', 'ULFO', 'ULMO']) {
      const dmg = join(work, 'app-' + fmt + '.dmg');
      sh('hdiutil', ['create', '-quiet', '-volname', 'Files Direct', '-srcfolder', app, '-format', fmt, '-ov', dmg]);
      note('.dmg (' + fmt + ')', statSync(dmg).size);
    }
  } else if (t.os === 'win32') {
    note('app folder, as installed', sizeOf(stage));
    const zip = join(work, 'app.zip');
    sh('tar', ['-a', '-cf', zip, '-C', stage, '.']);
    note('.zip (deflate)', statSync(zip).size);
    const sevenZ = ['7z', ...['C:\\Program Files\\7-Zip\\7z.exe']].find((c) => spawnSync(c, ['i'], { stdio: 'ignore' }).status === 0);
    if (sevenZ) {
      const z7 = join(work, 'app.7z');
      sh(sevenZ, ['a', '-mx=9', '-m0=lzma2', '-ms=on', z7, join(stage, '*')]);
      note('.7z (lzma2, solid)', statSync(z7).size);
    }
  } else {
    note('app folder', sizeOf(stage));
    const txz = join(work, 'app.tar.xz');
    sh('tar', ['-cJf', txz, '-C', stage, '.'], { env: { ...process.env, XZ_OPT: '-9e' } });
    note('.tar.xz', statSync(txz).size);
  }
}

export async function main(target, mode) {
  const t = TARGETS[target];
  if (!t) throw new Error('target: ' + Object.keys(TARGETS).join(' | '));
  const work = resolve(process.env.FD_APP_WORK ?? join(process.env.RUNNER_TEMP ?? 'app-work', 'files-direct-app-' + target));
  const cache = join(work, 'cache');
  const stage = join(work, 'stage');
  rmSync(stage, { recursive: true, force: true });
  const node = await fetchNode(target, cache);
  note('Node archive as downloaded (' + NODE_VERSION + ')', node.archiveBytes);
  note('Node binary alone', statSync(node.node).size);
  // the app's own folder: the runtime, the engine, the native file
  const res = t.os === 'darwin' ? join(stage, 'Files Direct.app', 'Contents', 'Resources') : stage;
  mkdirSync(res, { recursive: true });
  cpSync(node.node, join(res, t.os === 'win32' ? 'node.exe' : 'node'));
  cpSync(node.license, join(res, 'NODE-LICENSE'));
  await buildEngine(join(res, 'files-direct.mjs'));
  note('engine file', statSync(join(res, 'files-direct.mjs')).size);
  copyNative(target, res);
  note('native file of this system', sizeOf(join(res, 'node_modules', ...t.native.split('/'))));
  note('the connection library, loader and its one helper', sizeOf(join(res, 'node_modules')) - sizeOf(join(res, 'node_modules', ...t.native.split('/'))));
  if (mode === 'size') {
    // no shell yet in the measurement: about 0.1 MB on each system
    if (t.os === 'darwin') {
      mkdirSync(join(stage, 'Files Direct.app', 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(join(stage, 'Files Direct.app', 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Files Direct</string></dict></plist>\n');
    }
    packOptions(target, stage, work);
    const out = join(process.cwd(), 'app-sizes-' + target + '.json');
    writeFileSync(out, JSON.stringify({ target, node: NODE_VERSION, items: ITEMS }, null, 2) + '\n');
    console.log('wrote ' + out);
  }
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL('file://' + (process.platform === 'win32' ? '/' : '') + process.argv[1].replace(/\\/g, '/')).href) {
  try {
    await main(process.argv[2], process.argv[3] ?? 'size');
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
