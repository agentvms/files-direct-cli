// The checks of the double-click app (files-direct-34), run by .github/workflows/desktop-app.yml on GitHub's own macOS and Windows machines, one step at a time:
//   node scripts/app-check.mjs <step>
// mac-dmg | mac-app | mac-window | mac-update | win-app | win-window | win-hostile | win-update | selftest. Everything is for the runner's user only: no administrator, nothing system-wide, and everything a step
// installs it removes again, with a listing of the places an app could leave something, taken before and after, that has to come out the same.
// Nothing here touches the real site: the program is given a stand-in room service (scripts/stub-rooms.mjs) through FILES_DIRECT_ORIGIN, and updates come from a stand-in
// feed signed with a key made for this run and thrown away.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { entry, fileNames, keygen, makeFeed, signFeed } from './app-feed.mjs';
import { checkDmgFolder } from './dmg-layout.mjs';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const OUT = resolve(process.env.FD_APP_OUT ?? 'app-out');
const WORK = join(process.env.RUNNER_TEMP ?? tmpdir(), 'fd-app-check');
const SHOTS = join(process.cwd(), 'desktop-shots');
const TARGET = MAC ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : 'win-x64';

const problems = [];
const ok = (cond, text) => {
  console.log((cond ? 'ok      ' : 'FAILED  ') + text);
  if (!cond) problems.push(text);
  return cond;
};
const note = (text) => console.log('seen    ' + text.replace(/\n/g, '\n        '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Nothing here waits for ever: a program that does not end in five minutes is stopped and named, so a hung runner shows what it hung on (a step that hung for twenty minutes on windows-2025 left no log at all). */
const run = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...o });
  if (r.error?.code === 'ETIMEDOUT') console.log('stopped after ' + (o.timeout ?? 300_000) / 1000 + ' s: ' + cmd + ' ' + args.join(' ').slice(0, 160));
  return r;
};
/** Like run, without stopping this script: a stand-in site that runs inside it must be able to answer while the program waits for it. */
const runAsync = (cmd, args, o = {}) =>
  new Promise((done) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...o });
    const hung = setTimeout(() => {
      console.log('stopped after 300 s: ' + cmd + ' ' + args.join(' ').slice(0, 160));
      c.kill();
    }, 300_000);
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('error', (e) => done({ status: 127, stdout, stderr: String(e) }));
    c.on('close', (status) => {
      clearTimeout(hung);
      done({ status, stdout, stderr });
    });
  });
async function until(what, fn, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  console.log('waited ' + (ms / 1000) + ' s for: ' + what);
  return null;
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const tree = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1).replace(/\\/g, '/')])).sort();
const version = () => JSON.parse(readFileSync(join(OUT, 'build-' + TARGET + '.json'), 'utf8')).version;

// ---- the stand-in room service and a sender/receiver pair over it ---------------------------------------------------------------------

function startStub() {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'stub-rooms.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.stdout.once('data', (d) => done({ origin: 'http://127.0.0.1:' + JSON.parse(String(d)).port, stop: () => child.stdin.end() }));
  });
}

/** Sends the given files and folders from the window of the program at (node, engine) to a receiving program, and compares every byte by SHA-256. */
export async function transfer({ node, engine, origin, items, viaStdin = false, cwd = WORK }) {
  const env = { ...process.env, FILES_DIRECT_ORIGIN: origin };
  const args = [engine, 'open', '--app', '--no-window', '--json', ...(viaStdin ? ['--paths-stdin'] : ['--', ...items])];
  const sender = spawn(node, args, { env, cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  if (viaStdin) sender.stdin.end(Buffer.from(items.map((p) => p + '\0').join('')));
  let url = '';
  let buf = '';
  sender.stdout.on('data', (d) => {
    buf += d;
    for (const l of buf.split('\n')) {
      try {
        url ||= JSON.parse(l).url ?? '';
      } catch {
        /* a partial line */
      }
    }
  });
  const exited = new Promise((r) => sender.on('close', r));
  if (!ok(await until('the window address', () => url), 'the window started and said its address')) return false;
  const same = await completeTransfer({ url, node, engine, origin, items, cwd });
  await Promise.race([exited, sleep(10_000)]);
  sender.kill();
  return same;
}

/** Given the address of a window that is waiting with its files: a receiving program takes what is offered, the window is closed, and every byte is compared by SHA-256. */
async function completeTransfer({ url, node, engine, origin, items, cwd = WORK }) {
  const to = mkdtempSync(join(WORK, 'got-'));
  const env = { ...process.env, FILES_DIRECT_ORIGIN: origin };
  const post = (body) => fetch(url + 'act', { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(url).origin }, body: JSON.stringify(body) });
  const state = async () => (await fetch(url + 'state')).json();
  const waiting = await until('the room to be waiting', async () => {
    const s = await state();
    return s.phase === 'waiting' && s.link ? s : null;
  });
  if (!ok(waiting, 'the room is open and waiting, with a link and a code (' + (waiting?.items?.length ?? 0) + ' items listed)')) return false;
  const receiver = spawn(node, [engine, 'receive', waiting.link, '--to', to, '--json'], { env, cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  let said = '';
  receiver.stdout.on('data', (d) => (said += d));
  const done = await until('the transfer to finish', async () => {
    const s = await state();
    return s.phase === 'done' || s.phase === 'failed' || s.phase === 'cancelled' ? s : null;
  }, 90_000);
  ok(done?.phase === 'done', 'the window says the transfer is done' + (done ? ' (phase ' + done.phase + ': ' + done.message + ')' : ''));
  await post({ do: 'close' }).catch(() => {});
  receiver.kill();
  // every byte, by SHA-256
  let same = true;
  for (const item of items) {
    const name = basename(item);
    if (statSync(item).isDirectory()) {
      const sent = tree(item);
      const got = existsSync(join(to, name)) ? tree(join(to, name)) : [];
      same &&= JSON.stringify(sent) === JSON.stringify(got) && sent.every((f) => sha(join(item, f)) === sha(join(to, name, f)));
    } else same &&= existsSync(join(to, name)) && sha(item) === sha(join(to, name));
  }
  ok(same, 'every file that was sent arrived with the same SHA-256 (' + items.length + ' items, received into ' + to + ')');
  if (!same) note('receiver said: ' + said.slice(-500));
  return same;
}

/** The address of the window a menu entry opened: it is on the command line of the browser the program started (--app=<address>). */
async function findWindowUrl() {
  const processes = () =>
    MAC
      ? run('ps', ['-axo', 'args']).stdout
      : run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--app=http://127.0.0.1:*' } | ForEach-Object { $_.CommandLine }"]).stdout;
  return until('the window the entry opened', () => /--app=(http:\/\/127\.0\.0\.1:\d+\/w\/[\w-]+\/)/.exec(processes())?.[1] ?? null, 60_000);
}

/**
 * The real entry, not a stand-in: what the person's right-click runs (the Quick Action's script on a Mac; the registry command, once for each chosen item, on Windows)
 * starts the app's bundled Node and engine, which starts a window in a real browser. A receiving program then takes the files from it.
 * The receiving side is a program, not a browser page: the page that receives is the site's own and is not in this repository (it is checked against the window of the
 * packaged runtime on the Epic VM, e2e/window.spec.ts with FD_APP_DIR).
 */
async function entryTransfer({ node, engine, origin, files }) {
  // Windows: the browser path of the launcher (no WebView2: FILES_DIRECT_NO_WEBVIEW) is the one whose window is a browser's, with its address on the browser's command line; the app's own window is checked by win-window.
  // The Mac entry hands the files to the app, whose window is the app's own: it is checked by mac-window.
  const env = { ...process.env, FILES_DIRECT_ORIGIN: origin, ...(WIN ? { FILES_DIRECT_NO_WEBVIEW: '1' } : {}) };
  if (MAC) {
    // the Quick Action hands the files to the app, whose window is its own (no browser, so no address to read): that entry is checked end to end by mac-window; the bytes by the sends above
    note('the Quick Action opens the app\'s own window: checked by mac-window, not here');
    return true;
  } else {
    const commands = [KEYS[0], KEYS[0], KEYS[1]].map(regDefault);
    ok(commands.every(Boolean), 'read the commands of the installed registry entries');
    files.items.forEach((item, i) => {
      const line = commands[i].replace('%1', item); // what Explorer does with %1
      const exe = line.slice(1, line.indexOf('"', 1));
      const tail = line.slice(line.indexOf('"', 1) + 2);
      spawn(exe, [tail], { windowsVerbatimArguments: true, argv0: '"' + exe + '"', env, cwd: WORK, stdio: 'ignore', detached: true }).unref();
    });
  }
  const url = await findWindowUrl();
  if (!ok(url, 'the entry opened a window in a real browser (its address is on the browser\'s command line)')) return false;
  run(MAC ? 'screencapture' : 'powershell.exe', MAC ? ['-x', join(SHOTS, 'entry-window.png')] : ['-NoProfile', '-Command', 'exit 0']); // best effort: a build machine may have no screen
  return completeTransfer({ url, node, engine, origin, items: files.items });
}

/** Two files and a folder, with names made to run something. Windows does not allow some of the characters in a name. */
function sampleFiles() {
  const dir = mkdtempSync(join(WORK, 'files-'));
  const one = join(dir, WIN ? 'it\'s a "$(touch pwned)".txt'.replace(/"/g, '') : 'it\'s a "$(touch pwned)".txt');
  const two = join(dir, 'a;touch pwned & 100%.bin');
  const folder = join(dir, 'my folder');
  mkdirSync(join(folder, 'sub dir'), { recursive: true });
  writeFileSync(one, 'first file\n'.repeat(1000));
  writeFileSync(two, Buffer.alloc(300_000, 7));
  writeFileSync(join(folder, 'sub dir', '$HOME \'x\'.txt'), 'in a folder');
  writeFileSync(join(folder, 'plain.txt'), 'plain');
  return { dir, items: [one, two, folder] };
}
const noPwned = (...dirs) => dirs.every((d) => !readdirSync(d).some((n) => n.startsWith('pwned')));

// ---- listings: the places an app could leave something ---------------------------------------------------------------------------

const names = (d) => (existsSync(d) ? readdirSync(d).sort() : []);
// a runner's shared folders (Caches, Preferences and the like) change by themselves while a check runs: for those, the entries that carry our name are listed
const ours = (d) => names(d).filter((n) => /files.?direct|tnyforge/i.test(n));
const updateFolder = () => names(join(tmpdir(), 'files-direct-update')); // where a downloaded update waits (cli/src/app-install.ts)
const listing = () => {
  const h = homedir();
  if (MAC) {
    return {
      'Library/Services': names(join(h, 'Library/Services')),
      'Library/LaunchAgents': names(join(h, 'Library/LaunchAgents')),
      'Library/Application Support (our names)': ours(join(h, 'Library/Application Support')),
      'Library/Preferences (our names)': ours(join(h, 'Library/Preferences')),
      'Library/Caches (our names)': ours(join(h, 'Library/Caches')),
      'Library/Saved Application State (our names)': ours(join(h, 'Library/Saved Application State')),
      'Library/HTTPStorages (our names)': ours(join(h, 'Library/HTTPStorages')),
      Applications: names(join(h, 'Applications')),
      'temporary update folder': updateFolder(),
      processes: run('pgrep', ['-lx', 'FilesDirect']).stdout.trim() ? ['FilesDirect is running'] : [],
    };
  }
  const reg = (k) => run('reg.exe', ['query', k, '/s']).stdout.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).sort();
  const app = join(process.env.LOCALAPPDATA, 'Programs');
  return {
    'HKCU Classes *\\shell': reg('HKCU\\Software\\Classes\\*\\shell'),
    'HKCU Classes Directory\\shell': reg('HKCU\\Software\\Classes\\Directory\\shell'),
    'HKCU Uninstall': reg('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall').filter((l) => /^HKEY/.test(l)),
    'HKCU Run': reg('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'),
    SendTo: names(join(process.env.APPDATA, 'Microsoft', 'Windows', 'SendTo')),
    'Start menu': names(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')),
    'LocalAppData Programs': names(app),
    'temporary update folder': updateFolder(),
    processes: run('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.Path -like '*\\Programs\\Files Direct\\*' } | ForEach-Object { $_.ProcessName }"]).stdout.split(/\r?\n/).filter(Boolean),
  };
};
function sameListing(before, after, what) {
  const diffs = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  ok(diffs.length === 0, what + ': nothing left behind (' + Object.keys(before).length + ' places listed before and after)');
  for (const k of diffs) note('LEFT BEHIND in ' + k + ':\nbefore: ' + JSON.stringify(before[k]) + '\nafter:  ' + JSON.stringify(after[k]));
}

// ---- a stand-in feed, signed with a key made for this run -----------------------------------------------------------------------------

export function feedServer({ version, name, bytes, key, sign = key, mutate = (t) => t, serve = bytes }) {
  const text = makeFeed(version, { [TARGET]: entry(name, bytes) });
  const feed = mutate(text);
  const sig = signFeed(text, sign.secret);
  const server = createServer((req, res) => {
    const p = (req.url ?? '').replace('/desktop/', '');
    if (p === 'feed.json') return void res.writeHead(200).end(feed);
    if (p === 'feed.json.sig') return void res.writeHead(200).end(sig);
    if (p === name) return void res.writeHead(200, { 'content-length': String(serve.length) }).end(serve);
    res.writeHead(404).end();
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ origin: 'http://127.0.0.1:' + server.address().port, stop: () => server.close() })));
}

/** Builds the app as another version, with the test key in it, into a folder of its own. Only the file the app fetches by itself is made. */
function buildTestApp(out, key, extraEnv = {}) {
  const r = run(process.execPath, [join(import.meta.dirname, 'app-build.mjs'), TARGET, 'build'], { env: { ...process.env, FD_APP_OUT: out, FD_UPDATE_PUBLIC_KEY: key.public, FD_APP_ONLY: 'update', ...extraEnv }, stdio: ['ignore', 'inherit', 'inherit'], timeout: 900_000 });
  ok(r.status === 0, 'built the app for the update check into ' + out + ' ' + JSON.stringify(extraEnv));
}

// ---- Mac -------------------------------------------------------------------------------------------------------------------------------

const APPS = () => join(homedir(), 'Applications');
const BUNDLE = () => join(APPS(), 'Files Direct.app');
const RES = () => join(BUNDLE(), 'Contents', 'Resources');
const plistVersion = () => run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(BUNDLE(), 'Contents', 'Info.plist')]).stdout.trim();
const macRunning = () => run('pgrep', ['-x', 'FilesDirect']).stdout.trim().split('\n').filter(Boolean);
const quarantine = (p) => run('xattr', ['-w', 'com.apple.quarantine', '0081;' + Math.floor(Date.now() / 1000).toString(16) + ';Safari;00000000-0000-0000-0000-000000000000', p]);

function macStop() {
  for (const pid of macRunning()) run('kill', [pid]);
}

/** The built disk image, mounted read-only and not shown in the Finder: the same layout checks as the unit test makes on the folder before it is packed (scripts/dmg-layout.mjs, checkDmgFolder). */
async function macDmg() {
  mkdirSync(WORK, { recursive: true });
  const dmgName = fileNames(version()).download[TARGET];
  const mnt = join(WORK, 'mnt-layout');
  mkdirSync(mnt, { recursive: true });
  const att = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-quiet', '-mountpoint', mnt, join(OUT, dmgName)]);
  ok(att.status === 0, 'the disk image mounts read-only' + (att.status ? ': ' + att.stderr : ''));
  if (att.status !== 0) return;
  try {
    note('the disk image holds: ' + readdirSync(mnt).sort().join(', ') + '; the background folder holds: ' + (existsSync(join(mnt, '.background')) ? readdirSync(join(mnt, '.background')).join(', ') : 'nothing'));
    const found = checkDmgFolder(mnt);
    ok(found.length === 0, 'the disk image opens to the app, the Applications link, the background picture and the window layout' + (found.length ? ': ' + found.join('; ') : ''));
    ok(existsSync(join(mnt, 'Applications')), 'the Applications link leads somewhere on this machine (/Applications)');
  } finally {
    run('hdiutil', ['detach', '-quiet', mnt]);
  }
}

async function macApp() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(APPS(), { recursive: true });
  const before = listing();
  const names = fileNames(version());
  const dmgName = names.download[TARGET];
  const downloads = join(WORK, 'Downloads');
  mkdirSync(downloads, { recursive: true });
  const dmg = join(downloads, dmgName);
  cpSync(join(OUT, dmgName), dmg);
  ok(statSync(dmg).size > 1_000_000, 'the download is there: ' + dmgName + ' (' + (statSync(dmg).size / 1e6).toFixed(1) + ' MB)');
  // what a browser does to a download
  ok(quarantine(dmg).status === 0, 'marked the download as a browser does (com.apple.quarantine)');
  const sp1 = run('spctl', ['--assess', '--verbose=4', '--type', 'open', '--context', 'context:primary-signature', dmg]);
  note('spctl --assess --verbose=4 --type open --context context:primary-signature "' + dmgName + '" (the quarantined download), exit ' + sp1.status + ':\n' + (sp1.stdout + sp1.stderr).trim());
  // the person opens the disk image and drags the app to their own Applications folder
  const mnt = join(WORK, 'mnt');
  mkdirSync(mnt, { recursive: true });
  const att = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-quiet', '-mountpoint', mnt, dmg]);
  ok(att.status === 0 && existsSync(join(mnt, 'Files Direct.app')), 'the disk image opens and holds Files Direct.app' + (att.status ? ': ' + att.stderr : ''));
  const copy = run('ditto', [join(mnt, 'Files Direct.app'), BUNDLE()]);
  ok(copy.status === 0, 'copied the app into ' + APPS() + ' with no administrator and no sudo');
  run('hdiutil', ['detach', '-quiet', mnt]);
  const size = run('du', ['-sk', BUNDLE()]).stdout.split(/\s+/)[0];
  note('installed size: ' + (Number(size) / 1024).toFixed(1) + ' MB');
  const cs = run('codesign', ['--verify', '--strict', '--verbose=2', BUNDLE()]);
  ok(cs.status === 0, 'the signature seals the bundle (ad hoc, which is not Apple\'s): ' + (cs.stderr || cs.stdout).trim().replace(/\n/g, ' | '));
  quarantine(BUNDLE());
  const sp2 = run('spctl', ['--assess', '--verbose=4', '--type', 'execute', BUNDLE()]);
  note('spctl --assess --verbose=4 --type execute "Files Direct.app" (quarantined, as after a download), exit ' + sp2.status + ':\n' + (sp2.stdout + sp2.stderr).trim());
  ok(sp2.status !== 0, 'Gatekeeper does not accept the app as it is (exit ' + sp2.status + '): the first open needs the person\'s yes');
  // the person's yes ("Open Anyway") is stood in for by taking the mark off: nobody is at this machine to click
  run('xattr', ['-d', 'com.apple.quarantine', BUNDLE()]);
  ok(plistVersion() === version(), 'the app says it is version ' + version());

  const open = run('open', [BUNDLE()]);
  ok(open.status === 0, 'open "Files Direct.app" (as a double-click does)');
  const pids = await until('the menu-bar program', () => (macRunning().length ? macRunning() : null), 40_000);
  ok(pids && pids.length === 1, 'the menu-bar program is running, once (process ' + (pids ?? []).join(',') + ')');
  run('screencapture', ['-x', join(SHOTS, 'mac-menu-bar.png')]); // best effort: a runner may have no screen
  const wf = join(homedir(), 'Library', 'Services', 'Send with Files Direct.workflow', 'Contents', 'document.wflow');
  ok(await until('the Quick Action', () => existsSync(wf), 40_000), 'the app wrote the Quick Action itself on its first start');
  const script = run('plutil', ['-extract', 'actions.0.action.ActionParameters.COMMAND_STRING', 'raw', '-o', '-', wf]).stdout;
  ok(script.includes(BUNDLE()) && /"\$open" -a "\$app" "\$@"/.test(script), 'the Quick Action hands the chosen files over, as separate arguments, to the Files Direct app itself (open -a), so they open in its own window');
  ok(!script.includes('files-direct.mjs'), 'and does not run the engine on its own (that would open a browser)');
  run('/System/Library/CoreServices/pbs', ['-update']);
  const pb = run('/System/Library/CoreServices/pbs', ['-dump_pboard']);
  ok(/Send with Files Direct/.test(pb.stdout), 'the Service is registered (pbs -dump_pboard lists "Send with Files Direct")');

  // a send, through the installed app's own Node and engine, to a receiving program, over the stand-in room service
  const stub = await startStub();
  const files = sampleFiles();
  await transfer({ node: join(RES(), 'node'), engine: join(RES(), 'files-direct.mjs'), origin: stub.origin, items: files.items });
  ok(noPwned(files.dir, WORK), 'no file called pwned appeared anywhere');
  // and through the real entry: the installed Quick Action's script, the bundled Node, a window in a real browser
  const entryFiles = sampleFiles();
  await entryTransfer({ node: join(RES(), 'node'), engine: join(RES(), 'files-direct.mjs'), origin: stub.origin, files: entryFiles });
  ok(noPwned(entryFiles.dir, WORK), 'no file called pwned appeared anywhere (through the entry)');
  stub.stop();

  // the Quick Action, written for a stand-in program, with the app's own Node: names made to run something arrive as separate arguments
  await hostileMac();

  // Remove: the menu item runs these two steps (the Trash step needs the screen and is NOT YET CHECKED)
  macStop();
  await until('the menu-bar program to end', () => macRunning().length === 0, 15_000);
  const rm = run(join(RES(), 'node'), [join(RES(), 'files-direct.mjs'), 'app', 'remove']);
  note('app remove, exit ' + rm.status + ':\n' + (rm.stdout + rm.stderr).trim());
  rmSync(BUNDLE(), { recursive: true, force: true });
  run('/System/Library/CoreServices/pbs', ['-update']);
  ok(!/Send with Files Direct/.test(run('/System/Library/CoreServices/pbs', ['-dump_pboard']).stdout), 'the Service is gone from the list (pbs -dump_pboard)');
  sameListing(before, listing(), 'after Remove');
  rmSync(downloads, { recursive: true, force: true });
}

async function hostileMac() {
  const { installMenu, removeMenu, nodeEffects } = await import(await bundleMenu());
  const work = mkdtempSync(join(WORK, 'hostile-'));
  const fake = join(work, 'fake program', "files-direct '&' fake.mjs");
  mkdirSync(join(work, 'fake program'), { recursive: true });
  const out = join(work, 'argv.json');
  writeFileSync(fake, "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(out) + ', JSON.stringify(process.argv.slice(2)));\n');
  const hostile = ['plain.txt', 'two words.txt', 'say "hi".txt', "it's.txt", 'a;touch pwned.txt', '$(touch pwned).txt', '`touch pwned`.txt', 'a&touch pwned&.txt', '100%.txt', '%1 %L.txt', 'caret^name.txt', '-rf.txt', '--help', '$HOME', '! history', 'ünï-名前.txt', '  padded.txt', 'two\nlines.txt'];
  const dir = join(work, 'files');
  mkdirSync(dir);
  const files = hostile.map((n, i) => (writeFileSync(join(dir, n), 'c' + i), join(dir, n)));
  // the app's own Node runs a stand-in engine through the workflow the app's own code writes, in a home of its own
  const home = join(work, 'home');
  mkdirSync(home);
  const fx = nodeEffects({ HOME: home }, 'darwin');
  await installMenu({ node: join(RES(), 'node'), script: fake, app: true }, { ...fx, refreshServices: async () => {} });
  const wf = join(home, 'Library', 'Services', 'Send with Files Direct.workflow', 'Contents', 'document.wflow');
  const script = join(work, 'action.sh');
  writeFileSync(script, run('plutil', ['-extract', 'actions.0.action.ActionParameters.COMMAND_STRING', 'raw', '-o', '-', wf]).stdout);
  const r = run('/bin/bash', [script, ...files], { cwd: work });
  ok(r.status === 0, 'the Quick Action script ran, with the app\'s own Node');
  const got = JSON.parse((await until('the stand-in engine', () => existsSync(out) && readFileSync(out, 'utf8'))) ?? 'null');
  ok(got?.[0] === 'open' && got?.[1] === '--app' && got?.[2] === '--', 'the engine is told "open --app --" first');
  ok(JSON.stringify(got?.slice(3)) === JSON.stringify(files), 'all ' + files.length + ' hostile names reached the engine as separate arguments, in order, through the Quick Action and the bundled Node');
  ok(noPwned(work, dir), 'nothing else ran: no file called pwned');
  await removeMenu({ ...fx, refreshServices: async () => {} });
}

/** The program's own menu code, built into one file for this check (it is the same source the app is built from). */
async function bundleMenu() {
  const { build } = await import('esbuild');
  const r = await build({ stdin: { contents: "export * from './src/cli/src/menu.ts'; export { nodeEffects } from './src/cli/src/menu-node.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  const file = join(mkdtempSync(join(WORK, 'bundle-')), 'menu.mjs');
  writeFileSync(file, r.outputFiles[0].text);
  return new URL('file:///' + file.replace(/\\/g, '/')).href.replace('file:////', 'file:///');
}

async function macUpdate() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(APPS(), { recursive: true });
  const before = listing();
  const key = keygen();
  const other = keygen();
  const oldOut = join(WORK, 'old');
  const newOut = join(WORK, 'new');
  buildTestApp(oldOut, key);
  buildTestApp(newOut, key, { FD_APP_VERSION: '99.0.0' });
  const oldVersion = JSON.parse(readFileSync(join(oldOut, 'build-' + TARGET + '.json'), 'utf8')).version;
  const newName = fileNames('99.0.0').update[TARGET];
  const newBytes = readFileSync(join(newOut, newName));
  // the old app, as a person who already has it
  ok(run('tar', ['-xf', join(oldOut, fileNames(oldVersion).update[TARGET]), '-C', APPS()]).status === 0, 'unpacked the old app (' + oldVersion + ') into ' + APPS());
  ok(plistVersion() === oldVersion, 'it says it is ' + oldVersion);
  const node = join(RES(), 'node');
  const engine = join(RES(), 'files-direct.mjs');
  const asked = (origin, extra = []) => runAsync(node, [engine, 'update', 'install', '--json', '--wait-for', '1', ...extra], { env: { ...process.env, FILES_DIRECT_ORIGIN: origin } });
  const refuses = async (what, site, reason) => {
    const s = await feedServer(site);
    const r = await asked(s.origin);
    s.stop();
    const line = r.stdout.trim().split('\n').pop();
    ok(r.status === 1 && line.includes('"reason":"' + reason + '"'), what + ': refused with "' + reason + '"');
    ok(plistVersion() === oldVersion && !readdirSync(APPS()).some((n) => n.startsWith('.files-direct-update')), '  the app is still ' + oldVersion + ' and nothing was left next to it');
  };
  const tampered = Buffer.from(newBytes);
  tampered[100] ^= 1;
  await refuses('a file changed after it was signed', { version: '99.0.0', name: newName, bytes: newBytes, key, serve: tampered }, 'update_hash');
  await refuses('a list changed after it was signed', { version: '99.0.0', name: newName, bytes: newBytes, key, mutate: (t) => t.replace('99.0.0', '99.0.1') }, 'update_signature');
  await refuses('a list signed with another key', { version: '99.0.0', name: newName, bytes: newBytes, key, sign: other }, 'update_signature');
  await refuses('an older version', { version: '0.0.1', name: fileNames('0.0.1').update[TARGET], bytes: newBytes, key }, 'update_older');
  await refuses('a file longer than it was signed to be', { version: '99.0.0', name: newName, bytes: newBytes, key, serve: Buffer.concat([newBytes, Buffer.from('x')]) }, 'update_size');
  // the good one, through the menu-bar program itself (it asks, downloads, checks, quits; a script swaps the bundle and opens the new one)
  const site = await feedServer({ version: '99.0.0', name: newName, bytes: newBytes, key });
  const shell = spawn(join(BUNDLE(), 'Contents', 'MacOS', 'FilesDirect'), ['--update-now'], { env: { ...process.env, FILES_DIRECT_ORIGIN: site.origin }, stdio: 'ignore', detached: true });
  shell.unref();
  const gone = await until('the new version to be in place', () => plistVersion() === '99.0.0', 120_000);
  ok(gone, 'the update from our (stand-in) address was installed: the app says it is 99.0.0');
  const again = await until('the new app to be running', () => macRunning().length > 0, 60_000);
  ok(again, 'the menu-bar program is running again, as the new version');
  const v = run(join(RES(), 'node'), [join(RES(), 'files-direct.mjs'), 'version']).stdout.trim();
  ok(v === '99.0.0', 'the new engine says it is ' + v);
  ok(run('codesign', ['--verify', '--strict', BUNDLE()]).status === 0, 'the new bundle\'s signature is whole');
  site.stop();
  macStop();
  await until('the menu-bar program to end', () => macRunning().length === 0, 15_000);
  run(join(RES(), 'node'), [join(RES(), 'files-direct.mjs'), 'app', 'remove']);
  rmSync(BUNDLE(), { recursive: true, force: true });
  run('/System/Library/CoreServices/pbs', ['-update']);
  sameListing(before, listing(), 'after the update test and Remove');
}

// ---- Windows ------------------------------------------------------------------------------------------------------------------------------

const APPDIR = () => join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Files Direct');
const winRunning = () => run('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.Path -like '*\\Programs\\Files Direct\\*' } | ForEach-Object { $_.ProcessName + ' ' + $_.Id }"]).stdout.split(/\r?\n/).filter(Boolean);
const trayRunning = () => winRunning().filter((l) => /^Files Direct /.test(l));
const exeVersion = () => run('powershell.exe', ['-NoProfile', '-Command', "(Get-Item '" + join(APPDIR(), 'Files Direct.exe') + "').VersionInfo.ProductVersion"]).stdout.trim();
const KEYS = ['HKCU\\Software\\Classes\\*\\shell\\FilesDirect', 'HKCU\\Software\\Classes\\Directory\\shell\\FilesDirect'];
const SENDTO = () => join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'SendTo', 'Files Direct.lnk');
const regDefault = (key) => /REG_SZ\s+(.*)\r?$/m.exec(run('reg.exe', ['query', key + '\\command', '/ve']).stdout)?.[1]?.trim();
const lnk = (path) => {
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:FD_LNK); Write-Output $s.TargetPath; Write-Output $s.Arguments'], { env: { ...process.env, FD_LNK: path } });
  const [target, ...rest] = r.stdout.split(/\r?\n/);
  return { target, args: rest.join('').trim() };
};
const installerArgs = (log) => ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + log];

async function winInstall(file, label) {
  const log = join(WORK, 'setup-' + label + '.log');
  const r = run(file, installerArgs(log), { stdio: 'ignore', timeout: 300_000 });
  ok(r.status === 0, 'the installer ran silently (' + basename(file) + ')');
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  note('the installer\'s own log, lines about the mode it ran in:\n' + (text.split(/\r?\n/).filter((l) => /administrative|privilege|install mode|elevat|per.?user|current user/i.test(l)).slice(0, 12).join('\n') || '(none; the log has ' + text.length + ' characters)'));
  // the runner's own account is an administrator (the log says so); what matters is the mode the installer chose: not the all-users one, the current user's part of the registry, run as the current user
  ok(/Administrative install mode: No/.test(text) && /Install mode root key: HKEY_CURRENT_USER/.test(text) && /Run as: Current user/.test(text), 'the installer ran in the mode for the current user only (not the all-users mode)');
  ok(!/Running in administrative install mode|administrative install mode \(install for all users\)/i.test(text), 'it did not run as a system-wide install');
  ok(run('reg.exe', ['query', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s']).stdout.indexOf('Files Direct') < 0, 'nothing was written under HKLM');
  ok(existsSync(join(APPDIR(), 'Files Direct.exe')) && existsSync(join(APPDIR(), 'files-direct.mjs')), 'the app is in ' + APPDIR() + ' (the person\'s own folder)');
}

async function winApp() {
  mkdirSync(WORK, { recursive: true });
  const before = listing();
  const setup = join(OUT, fileNames(version()).download['win-x64']);
  ok(statSync(setup).size > 1_000_000, 'the installer is there: ' + basename(setup) + ' (' + (statSync(setup).size / 1e6).toFixed(1) + ' MB)');
  // what a browser does to a download, and what can be read of it without a desktop
  const sig = run('powershell.exe', ['-NoProfile', '-Command', "Set-Content -Path '" + setup + "' -Stream Zone.Identifier -Value \"[ZoneTransfer]`r`nZoneId=3\"; (Get-AuthenticodeSignature '" + setup + "').Status; Get-Content -Path '" + setup + "' -Stream Zone.Identifier"]);
  note('Mark of the Web set as a browser does, and the installer\'s Authenticode status:\n' + sig.stdout.trim() + '\nSmartScreen\'s own dialog is not shown to a program that starts the file, so its words are NOT seen here.');
  await winInstall(setup, 'first');
  const exeAt = join(APPDIR(), 'Files Direct.exe');
  const du = run('powershell.exe', ['-NoProfile', '-Command', "(Get-ChildItem -Recurse '" + APPDIR() + "' | Measure-Object -Property Length -Sum).Sum"]).stdout.trim();
  note('installed size: ' + (Number(du) / 1e6).toFixed(1) + ' MB');
  ok(exeVersion() === version(), 'Files Direct.exe says it is ' + version() + ' (' + exeVersion() + ')');
  const tray = await until('the tray program', () => (trayRunning().length ? trayRunning() : null), 40_000);
  ok(tray && tray.length === 1, 'the tray program is running, once (' + (tray ?? []).join(', ') + ')');
  ok(run('powershell.exe', ['-NoProfile', '-Command', "(Get-Process -Name 'Files Direct').MainWindowHandle.Count"]).status === 0, 'it has no console window (a program of the windows kind)');
  // the entries
  const launcherCmd = KEYS.map(regDefault);
  ok(launcherCmd.every((c) => c === '"' + exeAt + '" verb "%1"'), 'both registry entries start the launcher with one quoted %1: ' + launcherCmd[0]);
  const l = lnk(SENDTO());
  ok(l.target === exeAt && l.args === 'sendto', 'Send to starts the launcher: ' + l.target + ' ' + l.args);
  const uninstall = run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s']).stdout;
  ok(/DisplayName\s+REG_SZ\s+Files Direct/.test(uninstall), 'Apps settings lists Files Direct (the per-user uninstall entry)');
  ok(existsSync(join(APPDIR(), 'unins000.exe')), 'the uninstaller is in the app folder');

  // a send through the installed Node and engine, to a receiving program, over the stand-in room service
  const stub = await startStub();
  const files = sampleFiles();
  await transfer({ node: join(APPDIR(), 'node.exe'), engine: join(APPDIR(), 'files-direct.mjs'), origin: stub.origin, items: files.items, viaStdin: true });
  ok(noPwned(files.dir, WORK), 'no file called pwned appeared anywhere');
  // and through the real entries: the installed registry commands (once for each chosen item, as Explorer does), the launcher, the bundled Node, a window in a real browser
  const entryFiles = sampleFiles();
  await entryTransfer({ node: join(APPDIR(), 'node.exe'), engine: join(APPDIR(), 'files-direct.mjs'), origin: stub.origin, files: entryFiles });
  ok(noPwned(entryFiles.dir, WORK), 'no file called pwned appeared anywhere (through the entries)');
  stub.stop();

  // Remove: the uninstaller the menu item starts, with the tray program still running (the program closes it itself when the person chooses Remove in its menu; from Settings the uninstaller has to)
  const un = run(join(APPDIR(), 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore', timeout: 300_000 });
  ok(un.status === 0, 'the uninstaller ran silently');
  ok(await winFolderGoes('after uninstalling'), 'the app folder is gone');
  sameListing(before, listing(), 'after uninstalling');
}

async function winHostile() {
  mkdirSync(WORK, { recursive: true });
  for (const kind of ['naive', 'real']) {
    const work = mkdtempSync(join(WORK, 'hostile-' + kind + '-'));
    const home = join(work, 'App Folder');
    mkdirSync(home);
    cpSync(join(OUT, 'launcher', kind), home, { recursive: true }); // the launcher, and for the real one the files of its window (WebView2) beside it
    cpSync(process.execPath, join(home, 'node.exe'));
    const log = join(work, 'seen.json');
    // a stand-in engine: writes the words it was started with and what came on its standard input
    writeFileSync(join(home, 'files-direct.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(log + '.argv') + ", JSON.stringify(process.argv.slice(2))); const chunks = []; try { for await (const c of process.stdin) chunks.push(c); } catch {} writeFileSync(" + JSON.stringify(log) + ", JSON.stringify({ argv: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8').split('\\0').filter(Boolean) }));\n");
    // names Windows allows; the ones with a quote, a backslash or a line break cannot exist here
    const hostile = ['plain.txt', 'two words.txt', "it's.txt", 'a;touch pwned.txt', '$(touch pwned).txt', '`touch pwned`.txt', 'a&touch pwned&.txt', '100%.txt', '%1 %L %V.txt', 'caret^name.txt', '-rf.txt', '--help', '$HOME', '! history', '#hash', 'ünï-名前.txt', '  padded.txt', 'sp ace  double.txt'];
    const dir = join(work, 'files');
    mkdirSync(dir);
    const files = hostile.map((n, i) => (writeFileSync(join(dir, n), 'c' + i), join(dir, n)));
    const exe = join(home, 'Files Direct.exe');
    // what Explorer does: the registry command with %1 filled in, once per file; Send to: every file, each in quotes
    const verbOk = [];
    const sendtoLine = 'sendto ' + files.map((f) => '"' + f + '"').join(' ');
    // the command line Explorer builds: the program's path in quotes (it has a space in it), then the words; argv0 is how Node is told to write the first word as it is
    const first = run(exe, [sendtoLine], { windowsVerbatimArguments: true, argv0: '"' + exe + '"', cwd: work, stdio: 'ignore', timeout: 30_000 });
    // the careless launcher never gives the engine a standard input, so what it saw is read from the words it was started with
    const seen = JSON.parse((await until('the stand-in engine (' + kind + ')', () => (kind === 'naive' ? existsSync(log + '.argv') && JSON.stringify({ argv: JSON.parse(readFileSync(log + '.argv', 'utf8')), stdin: [] }) : existsSync(log) && readFileSync(log, 'utf8')), 20_000)) ?? 'null');
    // the real launcher asks for the app's own window (--shell-window) when WebView2 is on this machine; the careless one never does
    const expected = kind === 'naive' ? ['open', '--app', '--paths-stdin'] : ['open', '--app', '--shell-window', '--paths-stdin'];
    const exact = seen && JSON.stringify(seen.argv) === JSON.stringify(expected) && JSON.stringify(seen.stdin) === JSON.stringify(files);
    verbOk.push(exact);
    if (kind === 'real' && !exact) note('the launcher exited ' + first.status + (first.error ? ' (' + first.error + ')' : '') + '; the engine saw argv ' + JSON.stringify(seen?.argv) + ' and ' + (seen?.stdin?.length ?? 'no') + ' paths; first different path: ' + JSON.stringify((seen?.stdin ?? []).find((p, i) => p !== files[i])) + ' expected ' + JSON.stringify(files[(seen?.stdin ?? []).findIndex((p, i) => p !== files[i])]));
    if (kind === 'naive') ok(seen?.argv?.[0] === 'open' && !exact, 'the careless launcher (the paths pasted into the command line) is broken by these names, as it should be: the check can fail (the careless launcher did start the engine, and the names were not kept apart)' + (seen ? ' (the engine was started with ' + seen.argv.length + ' words, not ' + expected.length + ')' : ' (the engine did not start properly)'));
    else {
      ok(first.status === 0 && exact, 'the launcher started the engine with exactly "' + expected.join(' ') + '" and all ' + files.length + ' names on its standard input, none on the command line');
      rmSync(log, { force: true });
      run(exe, ['verb "' + files[3] + '"'], { windowsVerbatimArguments: true, argv0: '"' + exe + '"', cwd: work, stdio: 'ignore', timeout: 30_000 });
      const one = JSON.parse((await until('the stand-in engine (verb)', () => existsSync(log) && readFileSync(log, 'utf8'), 20_000)) ?? 'null');
      if (!(one && JSON.stringify(one.stdin) === JSON.stringify([files[3]]))) note('verb: the engine saw ' + JSON.stringify(one));
      ok(one && JSON.stringify(one.argv) === JSON.stringify(['open', '--app', '--shell-window', '--gather', '--paths-stdin']) && JSON.stringify(one.stdin) === JSON.stringify([files[3]]), 'the registry entry\'s form ("verb") passes one path and asks the engine to gather the others');
      // and with no WebView2 on the machine (FILES_DIRECT_NO_WEBVIEW stands in for it) the engine is asked for what it always was: the browser
      rmSync(log, { force: true });
      run(exe, ['verb "' + files[3] + '"'], { windowsVerbatimArguments: true, argv0: '"' + exe + '"', cwd: work, stdio: 'ignore', timeout: 30_000, env: { ...process.env, FILES_DIRECT_NO_WEBVIEW: '1' } });
      const old = JSON.parse((await until('the stand-in engine (no WebView2)', () => existsSync(log) && readFileSync(log, 'utf8'), 20_000)) ?? 'null');
      ok(old && JSON.stringify(old.argv) === JSON.stringify(['open', '--app', '--gather', '--paths-stdin']) && JSON.stringify(old.stdin) === JSON.stringify([files[3]]), 'without WebView2 the launcher asks the engine for the browser window, as before');
    }
    ok(noPwned(work, dir, home), 'nothing else ran (' + kind + '): no file called pwned');
  }
}

async function winUpdate() {
  mkdirSync(WORK, { recursive: true });
  const before = listing();
  const key = keygen();
  const other = keygen();
  const oldOut = join(WORK, 'old');
  const newOut = join(WORK, 'new');
  buildTestApp(oldOut, key);
  buildTestApp(newOut, key, { FD_APP_VERSION: '99.0.0' });
  const oldVersion = JSON.parse(readFileSync(join(oldOut, 'build-win-x64.json'), 'utf8')).version;
  const newName = fileNames('99.0.0').update['win-x64'];
  const newBytes = readFileSync(join(newOut, newName));
  await winInstall(join(oldOut, fileNames(oldVersion).update['win-x64']), 'old');
  ok(exeVersion() === oldVersion, 'the old app says it is ' + oldVersion);
  await until('the tray program', () => trayRunning().length > 0, 40_000);
  const node = join(APPDIR(), 'node.exe');
  const engine = join(APPDIR(), 'files-direct.mjs');
  const refuses = async (what, site, reason) => {
    const s = await feedServer(site);
    const r = await runAsync(node, [engine, 'update', 'install', '--json'], { env: { ...process.env, FILES_DIRECT_ORIGIN: s.origin } });
    s.stop();
    ok(r.status === 1 && r.stdout.includes('"reason":"' + reason + '"'), what + ': refused with "' + reason + '"');
    ok(exeVersion() === oldVersion, '  the app is still ' + oldVersion);
  };
  const tampered = Buffer.from(newBytes);
  tampered[1000] ^= 1;
  await refuses('a file changed after it was signed', { version: '99.0.0', name: newName, bytes: newBytes, key, serve: tampered }, 'update_hash');
  await refuses('a list changed after it was signed', { version: '99.0.0', name: newName, bytes: newBytes, key, mutate: (t) => t.replace('99.0.0', '99.0.1') }, 'update_signature');
  await refuses('a list signed with another key', { version: '99.0.0', name: newName, bytes: newBytes, key, sign: other }, 'update_signature');
  await refuses('an older version', { version: '0.0.1', name: fileNames('0.0.1').update['win-x64'], bytes: newBytes, key }, 'update_older');
  const site = await feedServer({ version: '99.0.0', name: newName, bytes: newBytes, key });
  for (const e of trayRunning()) run('taskkill', ['/PID', e.split(' ').pop(), '/F']);
  const shell = spawn(join(APPDIR(), 'Files Direct.exe'), ['--update-now'], { env: { ...process.env, FILES_DIRECT_ORIGIN: site.origin }, stdio: 'ignore', detached: true });
  shell.unref();
  ok(await until('the new version to be installed', () => exeVersion() === '99.0.0', 150_000), 'the update from our (stand-in) address was installed: Files Direct.exe says it is 99.0.0');
  ok(await until('the tray program', () => trayRunning().length > 0, 60_000), 'the tray program is running again, as the new version');
  ok(run(node, [engine, 'version']).stdout.trim() === '99.0.0', 'the new engine says it is 99.0.0');
  site.stop();
  for (const e of trayRunning()) run('taskkill', ['/PID', e.split(' ').pop(), '/T', '/F']);
  await winProgramsEnd(); // a tray program that was killed leaves its engine to end by itself: an uninstall that meets it cannot delete its node.exe (windows-2022 of the second head run)
  run(join(APPDIR(), 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore', timeout: 300_000 });
  await winFolderGoes('after the update test');
  sameListing(before, listing(), 'after the update test and uninstalling');
}

// ---- a check of the checks, on any machine that has the program built (npm run build:cli) ------------------------------------------------

async function selftest() {
  mkdirSync(WORK, { recursive: true });
  const stub = await startStub();
  const files = sampleFiles();
  const engine = existsSync('cli/dist/files-direct.mjs') ? 'cli/dist/files-direct.mjs' : 'dist/files-direct.mjs';
  await transfer({ node: process.execPath, engine: resolve(engine), origin: stub.origin, items: files.items, viaStdin: true });
  stub.stop();
}


// ---- files-direct-60: the app's own window ----------------------------------------------------------------------------------------------------
// The app is installed as a person would, and its engine file is replaced by a stand-in (scripts/app-window-stub.mjs; the real one stays beside it) that serves a page of its own: from
// the outside it can be seen that the window loaded the engine's address with the web engine of the system, that a link out of the page went to the system and not into the window, that a
// second Send started nothing, and what the window pressed when it was closed. What nobody at the screen would see is NOT seen here: the Dock and taskbar icon, how the window looks, and the
// red button on a Mac that gives a script no Accessibility.

const readLog = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const opensIn = (log) => readLog(log).filter((e) => e.what === 'started' && e.args[0] === 'open');

/** A stand-in for the site a link out of the page goes to: it records who asks. */
function startOutside() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url, ua: req.headers['user-agent'] ?? '' });
    res.end('outside');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ hits, origin: 'http://127.0.0.1:' + server.address().port, stop: () => server.close() })));
}

/** The stand-in engine in the place of the real one, with its settings beside it. Returns where its log and its "end" file are. */
function putStubIn(dir, outside) {
  const real = join(dir, 'files-direct-real.mjs');
  cpSync(join(dir, 'files-direct.mjs'), real);
  cpSync(join(import.meta.dirname, 'app-window-stub.mjs'), join(dir, 'files-direct.mjs'));
  const log = join(WORK, 'window-stub.log');
  const end = join(WORK, 'window-stub.end');
  rmSync(log, { force: true });
  rmSync(end, { force: true });
  writeFileSync(join(dir, 'window-stub.json'), JSON.stringify({ log, end, outside: outside.origin + '/from-the-window' }));
  return { log, end, real };
}

/** The windows of the app that are 480 wide and at least 500 tall, seen from outside the app. null when this machine would not say. The window asks for 480 by 760 inside (788 with its title bar), and a Mac makes any
 *  window fit its screen: on GitHub's macos-latest (arm64) the screen is 1024 by 768 with 677 free under the menu bar, so the window is 480 by 674 there (seen in the run of files-direct-60's fix-forward), and a real
 *  Mac with a small screen does the same. Other things of the app that are 480 wide are not this tall (a hidden 500 by 500 one, bars 1024 by 30). */
const MAC_WINDOWS = "ObjC.import('CoreGraphics'); const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))); JSON.stringify(all.filter(function (w) { return /Files ?Direct/.test(w.kCGWindowOwnerName || '') && w.kCGWindowIsOnscreen && w.kCGWindowBounds && w.kCGWindowBounds.Width === 480 && w.kCGWindowBounds.Height >= 500; }).map(function (w) { return { w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height, onscreen: Boolean(w.kCGWindowIsOnscreen) }; }))";
/** Every window of the app and the screens' sizes, as the machine says them (what to read when the list above is empty or odd: the screen of a runner can be small, and a window is made to fit its screen). */
const MAC_ALL = "ObjC.import('CoreGraphics'); ObjC.import('AppKit'); const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))); const list = $.NSScreen.screens; const screens = []; for (let i = 0; i < Number(list.count); i++) { const s = list.objectAtIndex(i); screens.push({ frame: [s.frame.size.width, s.frame.size.height], visible: [s.visibleFrame.size.width, s.visibleFrame.size.height] }); } JSON.stringify({ screens: screens, windows: all.filter(function (w) { return /Files ?Direct/.test(w.kCGWindowOwnerName || ''); }).map(function (w) { return { owner: w.kCGWindowOwnerName, name: w.kCGWindowName, layer: w.kCGWindowLayer, w: w.kCGWindowBounds && w.kCGWindowBounds.Width, h: w.kCGWindowBounds && w.kCGWindowBounds.Height, onscreen: Boolean(w.kCGWindowIsOnscreen) }; }) })";
const macSeen = () => {
  const r = run('osascript', ['-l', 'JavaScript', '-e', MAC_ALL]);
  return r.status === 0 ? r.stdout.trim() : 'not readable: ' + (r.stderr || '').trim().slice(0, 200);
};
const macWindows = () => {
  try {
    return JSON.parse(run('osascript', ['-l', 'JavaScript', '-e', MAC_WINDOWS]).stdout.trim());
  } catch {
    return null;
  }
};

async function macWindow() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(APPS(), { recursive: true });
  const before = listing();
  const dmgName = fileNames(version()).download[TARGET];
  const mnt = join(WORK, 'mnt-window');
  mkdirSync(mnt, { recursive: true });
  const att = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-quiet', '-mountpoint', mnt, join(OUT, dmgName)]);
  ok(att.status === 0 && existsSync(join(mnt, 'Files Direct.app')), 'the disk image opens' + (att.status ? ': ' + att.stderr : ''));
  ok(run('ditto', [join(mnt, 'Files Direct.app'), BUNDLE()]).status === 0, 'copied the app into ' + APPS());
  run('hdiutil', ['detach', '-quiet', mnt]);
  run('xattr', ['-d', 'com.apple.quarantine', BUNDLE()]);
  const outside = await startOutside();
  const stub = putStubIn(RES(), outside);
  ok(run('codesign', ['--force', '--sign', '-', BUNDLE()]).status === 0, 'the app was sealed again, ad hoc, with the stand-in engine inside');

  ok(run('open', [BUNDLE()]).status === 0, 'open "Files Direct.app"');
  const pids = await until('the menu-bar program', () => (macRunning().length ? macRunning() : null), 40_000);
  ok(pids && pids.length === 1, 'the menu-bar program is running, once');
  ok(await until('the listener', () => readLog(stub.log).some((e) => e.what === 'started' && e.args[0] === 'listen' && e.args.includes('--shell-window')), 40_000), 'the app started the listener of saved devices asking for its own window (listen --app --shell-window)');
  const wf = join(homedir(), 'Library', 'Services', 'Send with Files Direct.workflow', 'Contents', 'document.wflow');
  ok(await until('the Quick Action', () => existsSync(wf), 40_000), 'the app wrote the Quick Action itself');
  const script = join(WORK, 'window-action.sh');
  writeFileSync(script, run('plutil', ['-extract', 'actions.0.action.ActionParameters.COMMAND_STRING', 'raw', '-o', '-', wf]).stdout);

  // the right-click entry: the Quick Action hands a file to the app
  const dir = mkdtempSync(join(WORK, 'send-'));
  const file = join(dir, "it's one file.txt");
  writeFileSync(file, 'x');
  const sendOnce = () => run('/bin/bash', [script, file], { cwd: WORK });
  ok(sendOnce().status === 0, 'the installed Quick Action\'s own script ran with the chosen file');
  const started = await until('the engine run for the file', () => opensIn(stub.log)[0], 40_000);
  ok(started && JSON.stringify(started.args) === JSON.stringify(['open', '--app', '--shell-window', '--', file]), 'the app started one run of the engine for the file, asking for its own window, the name as one argument' + (started ? '' : ' (the app did not take the file from open -a: the Info.plist document types, or application(_:openFiles:), are not enough here)'));
  const loaded = await until('the page to be asked for', () => readLog(stub.log).find((e) => e.what === 'page'), 40_000);
  ok(Boolean(loaded) && /AppleWebKit/.test(loaded.ua) && !/Chrome\/|Edg\//.test(loaded.ua), 'the page was asked for by the app\'s own web view (WebKit), not by a browser: ' + (loaded?.ua ?? 'not asked for'));
  const wins = await until('the window', () => (macWindows()?.length ? macWindows() : null), 20_000);
  if (wins === null && macWindows() === null) note('the window list could not be read on this machine: the window itself is NOT seen here');
  else ok(wins?.length === 1, 'one window of the app, 480 wide, is on the screen list: ' + JSON.stringify(wins));
  note('every window of the app and the screens, as this machine says them:\n' + macSeen());
  run('screencapture', ['-x', join(SHOTS, 'mac-app-window.png')]); // best effort: a runner may have no screen

  // the page sends the window to the outside address: the system's browser gets it and the window stays on the page
  const hit = await until('the link out of the page', () => outside.hits[0], 40_000);
  ok(Boolean(hit), 'a link out of the page went to the system: the outside address was asked for (' + (hit?.ua ?? 'nobody') + ')');
  const pings = () => readLog(stub.log).filter((e) => e.what === 'ping').length;
  const p0 = pings();
  await sleep(2500);
  ok(pings() > p0, 'the window stayed on the page: it goes on asking the engine for its state');

  // a second Send while the window is open
  sendOnce();
  await sleep(5000);
  ok(opensIn(stub.log).length === 1, 'a second Send started no second run of the engine (' + opensIn(stub.log).length + ' runs)');
  if (macWindows()) ok(macWindows().length === 1, 'and no second window');

  // the meeting is over (what the engine says when the page's Close is pressed): the window goes, the menu-bar program stays
  writeFileSync(stub.end, '');
  const gone = await until('the window to close', () => macWindows()?.length === 0, 40_000);
  if (macWindows() === null) note('the window list could not be read: that the window closed is NOT seen here');
  else {
    if (!gone) note('the window did not close; every window of the app and the screens now:\n' + macSeen() + '\nwhat the stand-in engine logged last:\n' + readLog(stub.log).slice(-6).map((e) => JSON.stringify(e)).join('\n'));
    ok(gone, 'the window closed when the engine said the meeting was over');
  }
  ok(macRunning().length === 1, 'the menu-bar program is still running');
  ok(readLog(stub.log).some((e) => e.what === 'started' && e.args[0] === 'listen'), 'and its listener is still the one it started');

  // closed by the person: the red button, when this machine lets a script press it
  rmSync(stub.end, { force: true });
  sendOnce();
  await until('a second window', () => macWindows()?.length === 1, 30_000);
  const press = run('osascript', ['-e', 'tell application "System Events" to tell process "FilesDirect" to click button 1 of window 1']);
  if (press.status !== 0) note('closing by the red button was NOT tried: a script on this machine is not allowed to press it (' + (press.stderr || '').trim().slice(0, 160) + ')');
  else {
    ok(await until('the page\'s own Close', () => readLog(stub.log).find((e) => e.what === 'act' && /"do":"close"/.test(e.body)), 20_000), 'closing the window pressed the page\'s own Close (the engine was told)');
    const shut = await until('the window to close', () => macWindows()?.length === 0, 20_000);
    if (!shut) note('the window did not close; every window of the app and the screens now:\n' + macSeen() + '\nwhat the stand-in engine logged last:\n' + readLog(stub.log).slice(-8).map((e) => JSON.stringify(e)).join('\n'));
    ok(shut, 'and the window closed');
    ok(macRunning().length === 1, 'and the menu-bar program is still running');
  }

  // Remove, with the real engine, and everything the app made goes
  macStop();
  await until('the menu-bar program to end', () => macRunning().length === 0, 15_000);
  const rm = run(join(RES(), 'node'), [stub.real, 'app', 'remove']);
  note('app remove, exit ' + rm.status + ':\n' + (rm.stdout + rm.stderr).trim());
  rmSync(BUNDLE(), { recursive: true, force: true });
  run('/System/Library/CoreServices/pbs', ['-update']);
  outside.stop();
  sameListing(before, listing(), 'after Remove');
}

/** The ids of the programs that have a window called "Files Direct" open (the tray program has none). */
/** The temporary profiles of the app's windows that are on disk now (one per window, in the temporary folder, deleted when the window closes). */
const winProfiles = () => names(tmpdir()).filter((n) => n.startsWith('files-direct-window-'));

const winWindows = () => run('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.MainWindowTitle -eq 'Files Direct' } | ForEach-Object { $_.Id }"]).stdout.split(/\r?\n/).filter(Boolean);

/** The programs running from the app's folder (the tray program, an engine, the program of a right-click): a file of one of them cannot be deleted while it runs. */
const winAppPrograms = () => run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '" + APPDIR() + "\\*' } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.Name }"]).stdout.split(/\r?\n/).filter(Boolean);

/** Waits for every program that runs from the app's folder to end (a stopped tray program's engine goes a moment after it), so an uninstall does not meet a file in use. */
async function winProgramsEnd() {
  const gone = await until('the programs of the app to end', () => (winAppPrograms().length === 0 ? true : null), 40_000);
  if (!gone) note('programs still running from the app folder before the uninstall: ' + winAppPrograms().join(', '));
}

/** When the app's folder does not go after an uninstall: how long it took (up to five minutes), what is left in it, and every program that runs from it or is called like one of the app's. */
async function winFolderGoes(label) {
  const t0 = Date.now();
  const gone = await until('the app folder to go (' + label + ')', () => !existsSync(APPDIR()), 300_000);
  note('the app folder ' + (gone ? 'went after ' + Math.round((Date.now() - t0) / 1000) + ' s' : 'is still there after 300 s') + ' (' + label + ')');
  if (!gone) {
    note('what is left in the app folder:\n' + run('powershell.exe', ['-NoProfile', '-Command', "Get-ChildItem -Recurse -Force '" + APPDIR() + "' | Select-Object -First 30 | ForEach-Object { $_.FullName.Substring(" + APPDIR().length + ") + ' ' + $_.Length }"]).stdout.trim());
    note('programs that run from it or are called like the app\'s:\n' + run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '" + APPDIR() + "*' -or $_.Name -match 'unins|msedgewebview2|Files Direct|node' } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.Name + ' ' + $_.CommandLine }"]).stdout.trim());
  }
  return gone;
}

async function winWindow() {
  mkdirSync(WORK, { recursive: true });
  const before = listing();
  const setup = join(OUT, fileNames(version()).download['win-x64']);
  await winInstall(setup, 'window');
  const exe = join(APPDIR(), 'Files Direct.exe');
  ok(['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WEBVIEW2-LICENSE.txt', join('runtimes', 'win-x64', 'native', 'WebView2Loader.dll')].every((f) => existsSync(join(APPDIR(), f))), 'the files of the app\'s window (WebView2) were installed beside the program');
  // the tray program that the installer started uses the real engine: it is stopped, the stand-in goes in, and the tray program starts again
  run(exe, ['quit'], { stdio: 'ignore' });
  await until('the tray program to end', () => trayRunning().length === 0, 20_000);
  const outside = await startOutside();
  const stub = putStubIn(APPDIR(), outside);
  spawn(exe, [], { stdio: 'ignore', detached: true }).unref();
  const tray = await until('the tray program', () => (trayRunning().length ? trayRunning() : null), 40_000);
  ok(tray && tray.length === 1, 'the tray program is running, once');
  ok(await until('the listener', () => readLog(stub.log).some((e) => e.what === 'started' && e.args[0] === 'listen' && e.args.includes('--shell-window')), 40_000), 'the tray program started the listener asking for its own window (listen --app --shell-window)');

  // what Explorer does for the right-click entry: the registry command with the chosen file in place of %1
  const dir = mkdtempSync(join(WORK, 'send-'));
  const file = join(dir, "it's one file.txt");
  writeFileSync(file, 'x');
  const verb = (env = {}) => spawn(exe, ['verb "' + file + '"'], { windowsVerbatimArguments: true, argv0: '"' + exe + '"', cwd: WORK, stdio: 'ignore', detached: true, env: { ...process.env, ...env } }).unref();
  const profilesBefore = winProfiles();
  verb();
  const started = await until('the engine run for the file', () => opensIn(stub.log)[0], 40_000);
  ok(started && JSON.stringify(started.args) === JSON.stringify(['open', '--app', '--shell-window', '--gather', '--paths-stdin']), 'the right-click entry started one run of the engine asking for the app\'s own window' + (started ? '' : ' (no run was started)'));
  const loaded = await until('the page to be asked for', () => readLog(stub.log).find((e) => e.what === 'page'), 40_000);
  ok(Boolean(loaded) && /Edg\//.test(loaded.ua), 'the page was asked for by the app\'s own web view (the Microsoft Edge engine), not by a browser started for it: ' + (loaded?.ua ?? 'not asked for'));
  const wins = await until('the window', () => (winWindows().length ? winWindows() : null), 20_000);
  ok(wins && wins.length === 1, 'one window called "Files Direct" is open (in the program of the right-click: ' + JSON.stringify(wins) + ')');
  run('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save($env:FD_SHOT)"], { env: { ...process.env, FD_SHOT: join(SHOTS, 'win-app-window.png') } });

  const hit = await until('the link out of the page', () => outside.hits[0], 40_000);
  ok(Boolean(hit), 'a link out of the page went to the system: the outside address was asked for (' + (hit?.ua ?? 'nobody') + ')');
  const pings = () => readLog(stub.log).filter((e) => e.what === 'ping').length;
  const p0 = pings();
  await sleep(2500);
  ok(pings() > p0, 'the window stayed on the page: it goes on asking the engine for its state');

  // a second Send while the window is open
  verb();
  await sleep(5000);
  ok(opensIn(stub.log).length === 1, 'a second Send started no second run of the engine (' + opensIn(stub.log).length + ' runs)');
  ok(winWindows().length === 1, 'and no second window');

  // closed by the person: the window presses the page's own Close, the engine says the meeting is over, the window and its program end, the tray program stays
  const closed = run('powershell.exe', ['-NoProfile', '-Command', "(Get-Process | Where-Object { $_.MainWindowTitle -eq 'Files Direct' }).CloseMainWindow()"]);
  note('CloseMainWindow: ' + closed.stdout.trim());
  ok(await until('the page\'s own Close', () => readLog(stub.log).find((e) => e.what === 'act' && /"do":"close"/.test(e.body)), 20_000), 'closing the window pressed the page\'s own Close (the engine was told)');
  ok(await until('the window to go', () => winWindows().length === 0, 20_000), 'and the window closed');
  ok(await until('the program of the right-click to end', () => trayRunning().length === 1, 15_000), 'the tray program is still running (and it is the only program of the app left)');
  ok(readLog(stub.log).some((e) => e.what === 'started' && e.args[0] === 'listen'), 'and its listener is still the one it started');
  // the program of the right-click is gone now (only the tray program is left): the window's profile went before it did, not after
  const leftBehind = winProfiles().filter((n) => !profilesBefore.includes(n));
  ok(leftBehind.length === 0, 'the window\'s temporary profile is gone with the program of the right-click' + (leftBehind.length ? ' (left behind: ' + leftBehind.join(', ') + ')' : ''));

  // no WebView2 on this machine (FILES_DIRECT_NO_WEBVIEW stands in for it): the browser path, as before
  verb({ FILES_DIRECT_NO_WEBVIEW: '1' });
  const old = await until('the engine run without WebView2', () => opensIn(stub.log)[1], 40_000);
  ok(old && JSON.stringify(old.args) === JSON.stringify(['open', '--app', '--gather', '--paths-stdin']), 'without WebView2 the entry asks the engine for the browser window, as before');
  ok(winWindows().length === 0, 'and the app shows no window of its own');

  // Remove. The stand-in engine of the last Send (no window, so it ends by itself after 8 s) runs from the app's folder: an uninstall while it runs cannot delete its node.exe and leaves it behind (what the first
  // run of this check on its own machines showed, files-direct-60 fix-forward), so it is waited for, as a person would not uninstall in the middle of a send
  run(exe, ['quit'], { stdio: 'ignore' });
  await until('the tray program to end', () => trayRunning().length === 0, 20_000);
  await winProgramsEnd();
  const un = run(join(APPDIR(), 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore', timeout: 300_000 });
  ok(un.status === 0, 'the uninstaller ran silently');
  ok(await winFolderGoes('after uninstalling'), 'the app folder is gone');
  outside.stop();
  sameListing(before, listing(), 'after uninstalling');
}

const steps = { 'mac-dmg': macDmg, 'mac-app': macApp, 'mac-window': macWindow, 'mac-update': macUpdate, 'win-app': winApp, 'win-window': winWindow, 'win-hostile': winHostile, 'win-update': winUpdate, selftest };
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL('file://' + (WIN ? '/' : '') + process.argv[1].replace(/\\/g, '/')).href) {
  const step = steps[process.argv[2]];
  if (!step) {
    console.error('usage: node scripts/app-check.mjs <' + Object.keys(steps).join(' | ') + '>');
    process.exit(2);
  }
  mkdirSync(SHOTS, { recursive: true });
  try {
    await step();
  } catch (e) {
    ok(false, 'the step stopped: ' + String(e?.stack ?? e));
  }
  if (problems.length) {
    console.log('\n' + problems.length + ' check(s) failed:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  process.exit(0);
}
