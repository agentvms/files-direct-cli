/**
 * Where the Mac app lives (files-direct-56). Started from a disk image, from App Translocation (the system's temporary copy of a download) or from Downloads, the app offers once to
 * move itself to Applications. Every rule is here, in the program the app starts; the menu-bar program only asks (app place), shows the question, and says what was answered
 * (app move, app decline). Nothing in it needs an administrator: /Applications when the person can write there, else their own ~/Applications. What was declined stays on this
 * computer, in one small file in the app's own folder; it is not sent anywhere, and Remove takes it out with the rest.
 */
import { spawn } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAC_APP } from './app-install.ts';
import { DECLINE_FILE } from './store.ts';

export { DECLINE_FILE };
const DECLINE_MAX = 20;

export interface PlaceFacts {
  /** Where the running app is (for an app run from App Translocation, the temporary copy). */
  bundle: string;
  /** For a translocated app: where it really is, when the system said. */
  original?: string;
  home: string;
  /** Whether the person can write in /Applications (no password is ever asked for). */
  applicationsWritable: boolean;
  /** Whether a Files Direct.app is already in /Applications, and in ~/Applications. */
  exists: { applications: boolean; userApplications: boolean };
  /** The places a move was declined for. */
  declined: string[];
  /** Seconds since 1970: it makes the Trash names different from each other. */
  now: number;
}

export type PlaceKind = 'disk_image' | 'translocated' | 'downloads';

export type Place =
  | { ask: false; reason: 'in_applications' | 'elsewhere' | 'declined' }
  | {
      ask: true;
      from: PlaceKind;
      /** The app to take: the original for a translocated one when it is known. */
      source: string;
      /** The new place of the app: its folder is /Applications or ~/Applications. */
      target: string;
      /** copy: leave the app where it was (a disk image cannot be changed); move: the first copy goes to the Trash once the new one runs. */
      how: 'copy' | 'move';
      /** A Files Direct.app is already at the target: it goes to the Trash first, under this name. */
      replace: boolean;
      trash?: string;
      /** Where the first copy goes in the Trash, for how = move. */
      trashSource?: string;
      /** The disk image to eject once the new copy runs, only when the app came from one. */
      eject?: string;
    };

const isTranslocated = (path: string): boolean => path.includes('/AppTranslocation/');

/** The word a decline is kept under. A translocated copy has a new path every time it is opened, so all of them are one place unless the system names the original. */
export function locationKey(f: Pick<PlaceFacts, 'bundle' | 'original'>): string {
  return isTranslocated(f.bundle) ? (f.original ?? 'AppTranslocation') : f.bundle;
}

/** The words of the menu-bar menu's item that does the same move as the question, shown while the app runs from a place it should not stay in. */
export const MOVE_ITEM = 'Move to Applications to add the right-click entry';

/** Whether the app runs from a place it should not stay in: a disk image, a temporary copy of a download, Downloads. Null when it is in Applications or in a folder the person chose. */
function wrongPlace(f: Pick<PlaceFacts, 'bundle' | 'original' | 'home'>): { from: PlaceKind | null; where: string; inApplications: boolean } {
  const home = f.home.replace(/\/+$/, '');
  const translocated = isTranslocated(f.bundle);
  const where = translocated ? (f.original ?? f.bundle) : f.bundle;
  // the place the app really is: a translocated copy whose original is in Applications needs no move either (the copy and the target would be one folder)
  const inApplications = (!translocated || f.original !== undefined) && (where.startsWith('/Applications/') || where.startsWith(home + '/Applications/'));
  const from: PlaceKind | null = inApplications ? null : translocated ? 'translocated' : where.startsWith('/Volumes/') ? 'disk_image' : where.startsWith(home + '/Downloads/') ? 'downloads' : null;
  return { from, where, inApplications };
}

/** The menu-bar menu's item for moving, or null: shown for every place the question is asked about, whether or not the person said "Not now" to it, and never in Applications. */
export function menuItem(f: Pick<PlaceFacts, 'bundle' | 'original' | 'home'>): string | null {
  return wrongPlace(f).from ? MOVE_ITEM : null;
}

/** Whether to ask, and if so everything the move needs. A pure function of what is known: nothing here looks at the computer. */
export function decidePlace(f: PlaceFacts): Place {
  const home = f.home.replace(/\/+$/, '');
  const { from, where, inApplications } = wrongPlace(f);
  if (inApplications) return { ask: false, reason: 'in_applications' };
  if (!from) return { ask: false, reason: 'elsewhere' };
  if (f.declined.includes(locationKey(f))) return { ask: false, reason: 'declined' };
  const userFolder = !f.applicationsWritable;
  const target = (userFolder ? home + '/Applications/' : '/Applications/') + MAC_APP;
  const replace = userFolder ? f.exists.userApplications : f.exists.applications;
  // a copy that sits where the person's files go is moved; a disk image, or a temporary copy whose place is not known, is only copied
  const how = from === 'downloads' || (from === 'translocated' && f.original !== undefined && !f.original.startsWith('/Volumes/')) ? 'move' : 'copy';
  const stamp = 'Files Direct ' + f.now;
  return {
    ask: true,
    from,
    source: where,
    target,
    how,
    replace,
    ...(replace ? { trash: home + '/.Trash/' + stamp + '.app' } : {}),
    ...(how === 'move' ? { trashSource: home + '/.Trash/' + stamp + ' (first copy).app' } : {}),
    // whatever volume the app really came from, a translocated copy of an app opened from a disk image included
    ...(where.startsWith('/Volumes/') ? { eject: '/' + where.split('/').slice(1, 3).join('/') } : {}),
  };
}

/** The declined places in the file's text; anything that is not what this program wrote is "none". */
export function readDeclines(text: string | null): string[] {
  try {
    const j = JSON.parse(text ?? '') as { declined?: unknown };
    return Array.isArray(j.declined) ? j.declined.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 1024).slice(-DECLINE_MAX) : [];
  } catch {
    return [];
  }
}

/** The file's text with one more place declined (the newest twenty are kept). */
export function addDecline(text: string | null, key: string): string {
  const list = readDeclines(text).filter((k) => k !== key);
  return JSON.stringify({ declined: [...list, key].slice(-DECLINE_MAX) }) + '\n';
}

/** The part of the computer the decision and the move touch. The real one is nodePlaceEffects; a test brings a made-up one. */
export interface PlaceEffects {
  home: string;
  now(): number;
  /** True when a new folder can be made in it. */
  writable(dir: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** Copies the app into a new folder made beside where it will go (the same disk, so the last step is one move). Returns the folder and the app in it. */
  stage(source: string, targetDir: string): Promise<{ stage: string; bundle: string }>;
}

const run = (file: string, args: string[]): Promise<{ code: number; out: string }> =>
  new Promise((done) => {
    const c = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', (e) => done({ code: 1, out: String(e) }));
    c.on('close', (code) => done({ code: code ?? 1, out }));
  });

/** The real computer. The copy is made by ditto, which keeps what a Mac app is made of (links, the signature, extended attributes). */
export function nodePlaceEffects(env: Record<string, string | undefined> = process.env): PlaceEffects {
  return {
    home: env.HOME ?? homedir(),
    now: () => Math.floor(Date.now() / 1000),
    writable: (dir) => access(dir, constants.W_OK).then(() => true, () => false),
    exists: (path) => stat(path).then(() => true, () => false),
    read: (path) => readFile(path, 'utf8').catch(() => null),
    async write(path, text) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = path + '.' + process.pid + '.tmp';
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, path);
    },
    async stage(source, targetDir) {
      await mkdir(targetDir, { recursive: true });
      // next to where the app will be, under the name an update uses, so Remove clears it too if anything stops half way
      const stage = await mkdtemp(join(targetDir, '.files-direct-update-'));
      const bundle = join(stage, MAC_APP);
      const r = await run('/usr/bin/ditto', [source, bundle]);
      const ok = r.code === 0 && (await stat(join(bundle, 'Contents', 'Info.plist')).then(() => true, () => false));
      if (!ok) {
        await rm(stage, { recursive: true, force: true });
        throw new Error('Files Direct could not copy itself: ' + (r.out.trim() || 'the copy is not whole'));
      }
      return { stage, bundle };
    },
  };
}

/** What is known about the computer for one decision. Reads, writes nothing. */
export async function placeFacts(fx: PlaceEffects, dataFolder: string, where: { bundle: string; original?: string }): Promise<PlaceFacts> {
  const home = fx.home.replace(/\/+$/, '');
  return {
    ...where,
    home,
    applicationsWritable: await fx.writable('/Applications'),
    exists: { applications: await fx.exists('/Applications/' + MAC_APP), userApplications: await fx.exists(home + '/Applications/' + MAC_APP) },
    declined: readDeclines(await fx.read(join(dataFolder, DECLINE_FILE))),
    now: fx.now(),
  };
}

/**
 * Run by /bin/sh after the app has quit, with eight arguments (never pasted into the text): the app's process number, the copy that was made, the folder it was made in, the place it
 * goes, the Trash name for what is there now (empty: nothing is), the app that is quitting and the Trash name for it (empty: it stays), and the disk image to eject (empty: none).
 * It waits for the app to end (at most a minute), puts what is there in the Trash, moves the copy in, opens it, and only when a process runs that very copy (within ten seconds) puts the
 * first copy in the Trash and ejects the disk image. When the copy cannot be moved in, or does not start, the first copy and the disk image are left as they were and the first copy is opened again. The tools are the system's; a test points them at stand-ins.
 */
export const MOVE_SCRIPT = [
  'pid="$1"; new="$2"; stage="$3"; dst="$4"; trash="$5"; src="$6"; srcTrash="$7"; vol="$8"',
  'open="${FD_OPEN:-/usr/bin/open}"; detach="${FD_HDIUTIL:-/usr/bin/hdiutil}"; ps="${FD_PS:-/bin/ps}"',
  'n=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  n=$((n+1))',
  '  if [ "$n" -gt 600 ]; then rm -rf "$stage"; exit 1; fi',
  '  sleep 0.1',
  'done',
  'back() { rm -rf "$stage"; "$open" "$src"; exit 1; }',
  'if [ -n "$trash" ] && [ -e "$dst" ]; then mv "$dst" "$trash" || back; fi',
  'if ! mv "$new" "$dst"; then',
  '  if [ -n "$trash" ] && [ -e "$trash" ] && [ ! -e "$dst" ]; then mv "$trash" "$dst"; fi',
  '  back',
  'fi',
  'rm -rf "$stage"',
  '# the new copy is up when a process runs this very program (not just any process of the same name); if it is not, nothing of the first copy is touched and it is opened again',
  'exe="$dst/Contents/MacOS/FilesDirect"',
  'up=1',
  'if "$open" "$dst"; then',
  '  n=0',
  '  until "$ps" -axo comm= 2>/dev/null | grep -Fxq -- "$exe"; do',
  '    n=$((n+1))',
  '    if [ "$n" -gt "${FD_RUNNING_TICKS:-100}" ]; then up=0; break; fi',
  '    sleep 0.1',
  '  done',
  'else',
  '  up=0',
  'fi',
  'if [ "$up" = 0 ]; then "$open" "$src"; exit 1; fi',
  'if [ -n "$srcTrash" ] && [ "$src" != "$dst" ] && [ -e "$src" ]; then mv "$src" "$srcTrash"; fi',
  'if [ -n "$vol" ]; then "$detach" detach -quiet "$vol" || { sleep 2; "$detach" detach -quiet "$vol"; }; fi',
].join('\n');

/** Starts the move, which waits for process number "pid" (the menu-bar program) to end. Nothing is pasted into the script: it gets its words as arguments. */
export function startMove(o: { pid: number; place: Extract<Place, { ask: true }>; staged: { stage: string; bundle: string }; spawnFn?: typeof spawn; sh?: string; env?: Record<string, string | undefined> }): void {
  if (!Number.isInteger(o.pid) || o.pid < 1) throw new Error('no process to wait for');
  const p = o.place;
  const args = [String(o.pid), o.staged.bundle, o.staged.stage, p.target, p.trash ?? '', p.source, p.trashSource ?? '', p.eject ?? ''];
  const child = (o.spawnFn ?? spawn)(o.sh ?? '/bin/sh', ['-c', MOVE_SCRIPT, 'move', ...args], { detached: true, stdio: 'ignore', env: { ...process.env, ...o.env } });
  child.on('error', () => {});
  child.unref();
}