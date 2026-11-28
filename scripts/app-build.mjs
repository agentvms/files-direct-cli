// The Files Direct app, built for one system (files-direct-34). Run by .github/workflows/desktop-app.yml on a GitHub-hosted machine of that system:
//   node scripts/app-build.mjs <mac-arm64 | mac-x64 | win-x64> [size | build]
// size: measures the bare app in every way it could be packed. build: makes the app and the files a person downloads, in app-out/ (the Mac app is signed ad hoc, which is
// not Apple's signing; on Windows it also leaves the launcher in a careless form, for the check that shows a hostile name breaks it).
// Environment: FD_APP_VERSION (the version to build as; the checks build a newer one to try an update), FD_UPDATE_PUBLIC_KEY (a throwaway key for a check; the real key is in shared/config.ts).
// The app is the program's own engine (one file built from the same source as the command-line program), the Node it runs on (the official build,
// checked against a fixed SHA-256), and the one native file the connection library needs for this system. Nothing is downloaded but Node.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { fileNames } from './app-feed.mjs';
import { iconPng } from './icon-png.mjs';
import { VOLUME_NAME, buildDmgFolder } from './dmg-layout.mjs';

export const NODE_VERSION = '22.23.5';
/** Official Node archives (https://nodejs.org/dist/v<version>/SHASUMS256.txt) and the SHA-256 each one must have. */
export const TARGETS = {
  'mac-arm64': { os: 'darwin', archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d', native: '@node-datachannel/darwin-arm64', binary: 'bin/node' },
  'mac-x64': { os: 'darwin', archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422', native: '@node-datachannel/darwin-x64', binary: 'bin/node' },
  'win-x64': { os: 'win32', archive: `node-v${NODE_VERSION}-win-x64.zip`, sha256: '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3', native: '@node-datachannel/win32-x64-msvc', binary: 'node.exe' },
  // only for trying this script on a Linux machine (the packaged runtime against a real browser page on the Epic VM, scripts/e2e-packaged.mjs); no app is made for it
  'linux-x64': { os: 'linux', archive: `node-v${NODE_VERSION}-linux-x64.tar.xz`, sha256: 'cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8', native: '@node-datachannel/linux-x64-gnu', binary: 'bin/node' },
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
    define: { __FD_VERSION__: JSON.stringify(process.env.FD_APP_VERSION ?? pkg.version), __FD_ORIGIN__: JSON.stringify(origin), ...(process.env.FD_UPDATE_PUBLIC_KEY ? { __FD_UPDATE_KEY__: JSON.stringify(process.env.FD_UPDATE_PUBLIC_KEY) } : {}) },
    logLevel: 'warning',
  });
  return { version: process.env.FD_APP_VERSION ?? pkg.version, origin };
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

// ---- icons: one drawing, shared with the web app's icons (scripts/icon-png.mjs) -------------------------------------------------------------

/** A Windows .ico holding PNG pictures. */
export function iconIco(sizes = [16, 32, 48, 256]) {
  const pngs = sizes.map((s) => iconPng(s, { samples: s >= 256 ? 2 : 4 }));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

// ---- the Mac app -------------------------------------------------------------------------------------------------------------------------

export const BUNDLE_ID = 'com.tnyforge.filesdirect';
/**
 * The files and folders the right-click entry hands to the app (files-direct-60): the app is named by the entry (open -a), so it never becomes anyone's way of opening a kind of file
 * (LSHandlerRank None), but it says it can be given any file or folder, so the system hands them over.
 */
export const DOCUMENT_TYPES = '\n\t<key>CFBundleDocumentTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleTypeName</key>\n\t\t\t<string>Files and folders</string>\n\t\t\t<key>CFBundleTypeRole</key>\n\t\t\t<string>Viewer</string>\n\t\t\t<key>LSHandlerRank</key>\n\t\t\t<string>None</string>\n\t\t\t<key>LSItemContentTypes</key>\n\t\t\t<array>\n\t\t\t\t<string>public.item</string>\n\t\t\t\t<string>public.folder</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>';
export const infoPlist = (version) => '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n' +
  [['CFBundleName', 'Files Direct'], ['CFBundleDisplayName', 'Files Direct'], ['CFBundleIdentifier', BUNDLE_ID], ['CFBundleExecutable', 'FilesDirect'], ['CFBundlePackageType', 'APPL'], ['CFBundleShortVersionString', version], ['CFBundleVersion', version], ['CFBundleIconFile', 'AppIcon'], ['LSMinimumSystemVersion', '13.5']]
    .map(([k, v]) => '\t<key>' + k + '</key>\n\t<string>' + v + '</string>').join('\n') +
  '\n\t<key>LSUIElement</key>\n\t<true/>\n\t<key>NSHighResolutionCapable</key>\n\t<true/>' + DOCUMENT_TYPES + '\n</dict>\n</plist>\n';

function macIcns(work) {
  const set = join(work, 'AppIcon.iconset');
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  for (const [name, px] of [['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64], ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024]]) writeFileSync(join(set, name + '.png'), iconPng(px, { samples: px >= 256 ? 2 : 4 }));
  const out = join(work, 'AppIcon.icns');
  sh('iconutil', ['-c', 'icns', '-o', out, set]);
  return out;
}

/** Builds the .app, signed ad hoc (the free kind of signature: it makes the bundle whole, and Apple does not vouch for it). Returns its folder. */
function buildMacApp(target, stage, work, info) {
  const t = TARGETS[target];
  const app = join(stage, 'Files Direct.app');
  const res = join(app, 'Contents', 'Resources');
  const exe = join(app, 'Contents', 'MacOS', 'FilesDirect');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  sh('swiftc', ['-O', '-o', exe, join('app', 'mac', 'main.swift'), '-framework', 'AppKit', '-framework', 'WebKit']);
  cpSync(macIcns(work), join(res, 'AppIcon.icns'));
  writeFileSync(join(app, 'Contents', 'Info.plist'), infoPlist(info.version));
  writeFileSync(join(app, 'Contents', 'PkgInfo'), 'APPL????');
  chmodSync(join(res, 'node'), 0o755);
  // every program inside is signed ad hoc, then the bundle (which seals them)
  const natives = [join(res, 'node'), join(res, 'node_modules', ...t.native.split('/'), 'node_datachannel.node'), exe];
  for (const f of natives) sh('codesign', ['--force', '--sign', '-', f]);
  sh('codesign', ['--force', '--sign', '-', app]);
  const verify = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', app], { encoding: 'utf8' });
  console.log('codesign --verify --strict: exit ' + verify.status + ' ' + (verify.stderr || verify.stdout).trim().replace(/\n/g, ' | '));
  if (verify.status !== 0) throw new Error('the bundle does not verify');
  console.log(spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' }).stderr.trim());
  return app;
}

/**
 * The .dmg: the folder is made by scripts/dmg-layout.mjs (the app, the link to Applications, the background picture and the .DS_Store that lays the window out), and hdiutil only packs it:
 * lzma first; when this machine will not make it, the next way, and the one that was used is said.
 */
function makeDmg(app, out, work) {
  const folder = buildDmgFolder({ app, folder: join(work, 'dmg-folder') });
  const tries = [
    ['ULMO', ['create', '-quiet', '-volname', VOLUME_NAME, '-srcfolder', folder, '-format', 'ULMO', '-ov', out]],
    ['ULMO with HFS+', ['create', '-quiet', '-volname', VOLUME_NAME, '-srcfolder', folder, '-fs', 'HFS+', '-format', 'ULMO', '-ov', out]],
    ['UDRW then ULMO', null],
    ['ULFO', ['create', '-quiet', '-volname', VOLUME_NAME, '-srcfolder', folder, '-format', 'ULFO', '-ov', out]],
  ];
  for (const [name, args] of tries) {
    rmSync(out, { force: true });
    try {
      if (args) sh('hdiutil', args);
      else {
        const rw = join(work, 'rw.dmg');
        rmSync(rw, { force: true });
        sh('hdiutil', ['create', '-quiet', '-volname', VOLUME_NAME, '-srcfolder', folder, '-fs', 'HFS+', '-format', 'UDRW', '-ov', rw]);
        sh('hdiutil', ['convert', '-quiet', rw, '-format', 'ULMO', '-o', out]);
      }
      if (existsSync(out)) return name;
    } catch (e) {
      console.log('dmg: ' + name + ' did not work here: ' + String(e.message).slice(-300));
    }
  }
  throw new Error('no way of making the .dmg worked');
}

// ---- the Windows app -----------------------------------------------------------------------------------------------------------------------

/**
 * WebView2 (files-direct-60): the window of the Windows app is a WebView2, the Microsoft Edge engine that Windows 10 and 11 already have. Its three files come from Microsoft's own NuGet package at one
 * fixed version, checked against a fixed SHA-256 before anything is unpacked (the same rule as Node's archive above). They sit beside Files Direct.exe; nothing else is downloaded for it.
 */
export const WEBVIEW2_VERSION = '1.0.4370.26';
export const WEBVIEW2_SHA256 = '1c0dacac84b70109b3fd42f90c53a0ba942abc3a87590d7a4e0ccd86e4a06cf4';
export const WEBVIEW2_URL = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + WEBVIEW2_VERSION + '/microsoft.web.webview2.' + WEBVIEW2_VERSION + '.nupkg';
/** Inside the package, then where it goes beside the program: the managed pieces (net462, which the .NET Framework of every Windows runs), the loader for x64 where the managed piece looks for it, and the license Microsoft asks to ship. */
export const WEBVIEW2_FILES = [
  ['lib/net462/Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Core.dll'],
  ['lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'Microsoft.Web.WebView2.WinForms.dll'],
  ['runtimes/win-x64/native/WebView2Loader.dll', 'runtimes/win-x64/native/WebView2Loader.dll'],
  ['LICENSE.txt', 'WEBVIEW2-LICENSE.txt'],
];

/** The WebView2 package, after its SHA-256 matched the fixed one, with the files above unpacked into a folder of their own. */
export async function fetchWebView2(dir) {
  const file = join(dir, 'webview2-' + WEBVIEW2_VERSION + '.nupkg');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const res = await fetch(WEBVIEW2_URL);
    if (!res.ok) throw new Error('nuget.org answered ' + res.status + ' for the WebView2 package');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (sha !== WEBVIEW2_SHA256) throw new Error('the WebView2 package has SHA-256 ' + sha + ', not the fixed ' + WEBVIEW2_SHA256);
  const out = join(dir, 'unpacked-webview2');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  sh('tar', ['-xf', file, '-C', out, ...WEBVIEW2_FILES.map(([inside]) => inside)]);
  return { dir: out, core: join(out, WEBVIEW2_FILES[0][0]), winforms: join(out, WEBVIEW2_FILES[1][0]) };
}

/** Puts the WebView2 files beside the program (a folder with Files Direct.exe in it). */
export function placeWebView2(webview, into) {
  for (const [inside, name] of WEBVIEW2_FILES) {
    mkdirSync(join(into, ...name.split('/').slice(0, -1)), { recursive: true });
    cpSync(join(webview.dir, inside), join(into, ...name.split('/')));
  }
}

const frameworkCsc = () => join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

/** Compiles the tray and launcher program with the compiler that is in every Windows (C# 5, .NET Framework 4). */
export function compileLauncher(out, work, version, naive = false, manifest = null, webview = null) {
  if (!webview) throw new Error('the launcher shows the app\'s window with WebView2: its files are needed to build it (fetchWebView2)');
  mkdirSync(work, { recursive: true });
  const ico = join(work, 'app.ico');
  writeFileSync(ico, iconIco());
  const v = version.split('.').concat(['0']).slice(0, 4).join('.');
  const info = join(work, 'AssemblyInfo.cs');
  writeFileSync(info, 'using System.Reflection;\n[assembly: AssemblyTitle("Files Direct")]\n[assembly: AssemblyProduct("Files Direct")]\n[assembly: AssemblyVersion("' + v + '")]\n[assembly: AssemblyFileVersion("' + v + '")]\n[assembly: AssemblyInformationalVersion("' + version + '")]\n');
  const args = ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/out:' + out, '/win32icon:' + ico, '/r:System.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', '/r:' + webview.core, '/r:' + webview.winforms, ...(naive ? ['/define:FD_NAIVE'] : []), ...(manifest ? ['/win32manifest:' + manifest] : []), join('app', 'win', 'FilesDirect.cs'), info];
  console.log('csc ' + args.join(' '));
  sh(frameworkCsc(), args);
  return ico;
}

function findIscc() {
  const known = [process.env['ProgramFiles(x86)'] + '\\Inno Setup 6\\ISCC.exe', process.env.ProgramFiles + '\\Inno Setup 6\\ISCC.exe', process.env.LOCALAPPDATA + '\\Programs\\Inno Setup 6\\ISCC.exe'];
  return known.find((p) => existsSync(p));
}
function innoCompiler() {
  let iscc = findIscc();
  if (!iscc) {
    console.log('Inno Setup is not on this machine: installing it with Chocolatey (a build tool, on this build machine only)');
    sh('choco', ['install', 'innosetup', '--yes', '--no-progress']);
    iscc = findIscc();
  }
  if (!iscc) throw new Error('Inno Setup was not found');
  console.log('Inno Setup: ' + iscc + ' ' + (spawnSync(iscc, ['/?'], { encoding: 'utf8' }).stdout || '').split('\n')[0]);
  return iscc;
}

function buildWinInstaller(stage, work, outDir, version, ico) {
  sh(innoCompiler(), ['/Qp', '/DAppVersion=' + version, '/DSourceDir=' + stage, '/DOutDir=' + outDir, '/DIcon=' + ico, join('app', 'win', 'installer.iss')]);
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
      try {
        sh('hdiutil', ['create', '-quiet', '-volname', VOLUME_NAME, '-srcfolder', app, '-format', fmt, '-ov', dmg]);
        note('.dmg (' + fmt + ')', statSync(dmg).size);
      } catch (e) {
        console.log('size    .dmg (' + fmt + ') could not be made on this machine: ' + String(e.message).slice(-200));
      }
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
  const outDir = resolve(process.env.FD_APP_OUT ?? 'app-out');
  const updateOnly = process.env.FD_APP_ONLY === 'update'; // a check that only needs the file the app fetches by itself
  rmSync(stage, { recursive: true, force: true });
  const node = await fetchNode(target, cache);
  note('Node archive as downloaded (' + NODE_VERSION + ')', node.archiveBytes);
  note('Node binary alone', statSync(node.node).size);
  // the app's own folder: the runtime, the engine, the native file
  const res = t.os === 'darwin' ? join(stage, 'Files Direct.app', 'Contents', 'Resources') : stage;
  mkdirSync(res, { recursive: true });
  cpSync(node.node, join(res, t.os === 'win32' ? 'node.exe' : 'node'));
  cpSync(node.license, join(res, 'NODE-LICENSE'));
  const info = await buildEngine(join(res, 'files-direct.mjs'));
  // the engine knows it is the app, and for which kind of computer, from this file beside it
  writeFileSync(join(res, 'app.json'), JSON.stringify({ target, version: info.version }) + '\n');
  note('engine file', statSync(join(res, 'files-direct.mjs')).size);
  copyNative(target, res);
  note('native file of this system', sizeOf(join(res, 'node_modules', ...t.native.split('/'))));
  note('the connection library, loader and its one helper', sizeOf(join(res, 'node_modules')) - sizeOf(join(res, 'node_modules', ...t.native.split('/'))));
  mkdirSync(outDir, { recursive: true });
  const names = fileNames(info.version);
  const report = { target, version: info.version, node: NODE_VERSION, items: ITEMS };

  if (mode === 'size') {
    // no shell in the measurement: about 0.1 MB on each system
    if (t.os === 'darwin') {
      mkdirSync(join(stage, 'Files Direct.app', 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(join(stage, 'Files Direct.app', 'Contents', 'Info.plist'), infoPlist(info.version));
    }
    packOptions(target, stage, work);
    writeFileSync(join(process.cwd(), 'app-sizes-' + target + '.json'), JSON.stringify(report, null, 2) + '\n');
    return;
  }

  if (t.os === 'darwin') {
    const app = buildMacApp(target, stage, work, info);
    note('Files Direct.app, installed', sizeOf(app));
    const txz = join(outDir, names.update[target]);
    // COPYFILE_DISABLE keeps the macOS file-metadata companions ("._name") out of the archive
    sh('tar', ['-cJf', txz, '-C', stage, 'Files Direct.app'], { env: { ...process.env, XZ_OPT: '-9e', COPYFILE_DISABLE: '1' } });
    note('update file (' + names.update[target] + ')', statSync(txz).size);
    if (!updateOnly) {
      const dmg = join(outDir, names.download[target]);
      const how = makeDmg(app, dmg, work);
      note('download (' + names.download[target] + ', ' + how + ')', statSync(dmg).size);
      report.dmgFormat = how;
    }
  } else if (t.os === 'win32') {
    const launcher = join(stage, 'Files Direct.exe');
    const webview = await fetchWebView2(join(cache, 'webview2'));
    const ico = compileLauncher(launcher, work, info.version, false, null, webview);
    placeWebView2(webview, stage); // the installer packs the whole folder: the window's files ship with the program
    mkdirSync(join(outDir, 'launcher', 'real'), { recursive: true });
    cpSync(launcher, join(outDir, 'launcher', 'real', 'Files Direct.exe'));
    placeWebView2(webview, join(outDir, 'launcher', 'real'));
    if (!updateOnly) compileLauncherNaive(work, info.version, outDir, webview);
    note('Files Direct.exe (tray and launcher)', statSync(launcher).size);
    note('installed folder', sizeOf(stage));
    buildWinInstaller(stage, work, outDir, info.version, ico);
    note('installer (' + names.download[target] + ')', statSync(join(outDir, names.download[target])).size);
  } else throw new Error('no app is made for ' + target);
  writeFileSync(join(outDir, 'build-' + target + '.json'), JSON.stringify(report, null, 2) + '\n');
}

/** The careless launcher, for the check that shows a hostile name breaks it. Never part of what is shipped. */
function compileLauncherNaive(work, version, outDir, webview) {
  const dir = join(outDir, 'launcher', 'naive');
  mkdirSync(dir, { recursive: true });
  compileLauncher(join(dir, 'Files Direct.exe'), join(work, 'naive'), version, true, null, webview);
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL('file://' + (process.platform === 'win32' ? '/' : '') + process.argv[1].replace(/\\/g, '/')).href) {
  try {
    await main(process.argv[2], process.argv[3] ?? 'size');
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
