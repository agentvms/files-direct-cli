import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { cleanNote } from '../../shared/ask.ts';
import { formatCode } from '../../shared/code.ts';
import { doorOf } from './door.ts';
import { TEST_LANE_HEADER } from '../../shared/config.ts';
import { PASSWORD_MAX_CHARS } from '../../shared/config.ts';
import { installBrowserParts } from './node-env.ts';
import { VERSION, originFrom, roomEnv } from './config.ts';
import { collect } from './fs-source.ts';
import { terminalQr } from './qr.ts';
import { type ProgramEvent, type Result, ask, receive, send } from './room.ts';
import { EXIT, reasonText, waitText } from './words.ts';
import { Refused } from './safe-path.ts';

export { doorOf };

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** The terminal can draw progress in place and colours. */
  tty: boolean;
  env: Record<string, string | undefined>;
  /** Signals: the first one cancels the transfer, the second leaves at once. */
  onInterrupt?(handler: () => void): () => void;
}

export const USAGE = `Files Direct: send and receive files and folders from a terminal or a script, with no browser.

Usage:
  files-direct send <file or folder>... [--password <word>] [--allow-code] [--timeout <minutes>] [--json]
  files-direct receive <link or nine-digit code> [--to <folder>] [--max-size <size>] [--overwrite] [--password <word>] [--json]
  files-direct ask [--note <text>] [--to <folder>] [--timeout <minutes>] [--max-size <size>] [--max-files <number>] [--allow-code] [--password <word>] [--json]
  files-direct mcp [--allow <folder>]...        run as a local MCP server for an assistant (talks over stdin and stdout)
  files-direct version

Send prints a link, a nine-digit code and a QR code, then waits for the other device. Receiving a link or code is the yes: the program lists
what is offered, then takes it, straight to disk, checking every block and every file. It never replaces a file unless you say --overwrite.
A person who types the sender's nine-digit code is turned away unless you start the sender with --allow-code (a code can be guessed; a link cannot).

Ask opens a room that asks for files, and prints a link, a nine-digit code and a QR code like send. The person who opens it sees that they are being asked, by
what kind of device, and your note (--note, up to 200 characters, shown only to them), and chooses the files. They go straight to --to (default: this folder), checked
like any transfer. The ask is the yes: nothing is replaced, and an offer over --max-size or --max-files (default 1000) is refused. The run ends after the first batch
is saved, or after --timeout minutes (default 30) when no files have started to arrive. Keep it running until then: nothing is stored on our servers.

--json prints one JSON object per line instead of text, and ends with {"event":"finished"} or {"event":"failed","reason":"..."}.
Exit status: 0 done, 2 the command was typed wrong, 3 the other side said no (or, for ask, sent nothing in time), 4 could not get in, 5 a limit (wait and try again),
6 out of date, 7 cancelled, 8 the transfer broke, 9 refused by a rule (too big, would replace a file, path not allowed), 1 anything else.

--site <address> or FILES_DIRECT_ORIGIN names the site (the address this program was built with is the default).
`;

const size = (n: number): string => {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return (u === 0 ? String(v) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[u];
};

/** "500MB", "2 GB", "1.5GiB", or a plain number of bytes. Null when it is not a size. */
export function parseSize(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)\s*$/i.exec(text);
  if (!m) return null;
  const unit = m[2]!.toLowerCase();
  const bin = unit.includes('i');
  const k = bin ? 1024 : 1000;
  const power = unit.startsWith('k') ? 1 : unit.startsWith('m') ? 2 : unit.startsWith('g') ? 3 : unit.startsWith('t') ? 4 : 0;
  return Math.round(Number(m[1]) * k ** power);
}

function describe(e: ProgramEvent, tty: boolean): string | null {
  switch (e.event) {
    case 'room':
      return '';
    case 'knock':
      return e.allowed ? 'Someone typed the code and was let in (--allow-code).' : 'Someone typed the code. They were turned away, because this sender has nobody at the keyboard. Start it with --allow-code to let a code in, or share the link.';
    case 'knocking':
      return 'Waiting for the sender to let you in…';
    case 'joined':
      return `Connected with ${e.device}.`;
    case 'connected':
      return e.route === 'relay' ? 'Connected through our servers.' : 'Connected directly.';
    case 'offered':
      return `Offered: ${e.files === 1 ? '1 file' : e.files + ' files'} (${size(e.bytes)})\n${e.names.slice(0, 20).map((n) => `  ${n.name} (${size(n.size)})`).join('\n')}${e.names.length > 20 ? `\n  … and ${e.files - 20} more` : ''}`;
    case 'accepted':
      return 'Taking it.';
    case 'progress':
      return tty ? null : null;
    case 'file':
      return e.path ? `Saved ${e.path}` : `Sent ${e.name}`;
    case 'skipped':
      return `Left out ${e.path}: ${e.reason === 'link' ? 'it is a link' : e.reason === 'protected' ? 'it holds keys or passwords' : 'it is not a regular file'}.`;
    case 'wait':
      return `Wait ${waitText(e.seconds)} before trying again.`;
    case 'meter':
      return `Through our servers: ${(e.used / 1e9).toFixed(1)} of ${(e.free / 1e9).toFixed(0)} GB of the free amount used.`;
    case 'paused':
      return e.by === 'this' ? 'Paused.' : 'The other side paused the transfer.';
    case 'resumed':
      return 'Carrying on.';
    case 'finished':
      return null;
    case 'failed':
      return null;
  }
}

function bar(done: number, total: number, speed: number, eta: number | null, file: string): string {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
  const left = eta === null ? '' : eta < 10 ? ', a few seconds left' : eta < 60 ? `, ${Math.round(eta)} seconds left` : eta < 3600 ? `, about ${Math.round(eta / 60)} min left` : `, about ${Math.floor(eta / 3600)} h ${Math.round((eta % 3600) / 60)} min left`;
  return `${String(pct).padStart(3)}%  ${size(done)} of ${size(total)}  ${size(speed)}/s${left}  ${file}`;
}

/** Runs one command and resolves its exit status. */
export async function runCli(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  if (command === 'version' || command === '--version') {
    io.out(VERSION);
    return 0;
  }
  if (command !== 'send' && command !== 'receive' && command !== 'ask') {
    io.err(`Unknown command "${command}". Run files-direct help.`);
    return 2;
  }
  let args;
  try {
    args = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        site: { type: 'string' },
        password: { type: 'string' },
        'allow-code': { type: 'boolean' },
        timeout: { type: 'string' },
        to: { type: 'string' },
        'max-size': { type: 'string' },
        'max-files': { type: 'string' },
        note: { type: 'string' },
        overwrite: { type: 'boolean' },
        qr: { type: 'boolean' },
        'no-qr': { type: 'boolean' },
      },
    });
  } catch (e) {
    io.err((e as Error).message + '. Run files-direct help.');
    return 2;
  }
  const v = args.values;
  const json = Boolean(v.json);
  const usage = (text: string) => {
    if (json) io.out(JSON.stringify({ event: 'failed', reason: 'usage', message: text }));
    else io.err(text + ' Run files-direct help.');
    return 2;
  };
  const origin = originFrom(v.site, io.env);
  if (!origin) return usage('No site address: pass --site <address> or set FILES_DIRECT_ORIGIN.');
  const password = v.password ?? io.env.FILES_DIRECT_PASSWORD;
  if (password !== undefined && (password.length === 0 || password.length > PASSWORD_MAX_CHARS)) return usage(`The password must be 1 to ${PASSWORD_MAX_CHARS} characters.`);
  const lane = io.env.FD_TEST_LANE_TOKEN; // a check on the live site marks its rooms as tests (docs/TEST-LANE.md)
  const headers = lane ? { [TEST_LANE_HEADER]: lane } : undefined;

  const emit = (e: ProgramEvent) => {
    if (json) return io.out(JSON.stringify({ ...e, at: new Date().toISOString() }));
    if (e.event === 'room') {
      io.out(`Link:  ${e.link}\nCode:  ${formatCode(e.code)}${e.password ? '\nA password is set. The other person will be asked for it.' : ''}`);
      const waiting = command === 'ask' ? 'Waiting for someone to open it and send files. Keep this running until they arrive: nothing is stored on our servers.' : 'Waiting for the other device…';
      if ((io.tty && !v['no-qr']) || v.qr) io.out('\n' + terminalQr(e.link) + '\nScan with a phone camera, or share the link or code.\n' + waiting);
      else io.out(waiting);
      return;
    }
    if (e.event === 'progress') {
      if (io.tty) io.out('\r' + bar(e.done, e.total, e.speed, e.eta, e.file).slice(0, 110).padEnd(110) + '\r');
      return;
    }
    const line = describe(e, io.tty);
    if (line) io.out((io.tty ? '\x1b[2K' : '') + line);
  };

  installBrowserParts();
  const env = await roomEnv(origin, headers);
  let run;
  if (command === 'send') {
    if (args.positionals.length === 0) return usage('Name at least one file or folder to send.');
    let picked;
    try {
      picked = await collect(args.positionals.map((p) => resolve(p)));
    } catch (e) {
      if (e instanceof Refused) return usage(e.message);
      throw e;
    }
    const minutes = v.timeout === undefined ? 30 : Number(v.timeout);
    if (!Number.isFinite(minutes) || minutes < 0) return usage('--timeout takes a number of minutes (0 waits for ever).');
    run = send(env, { files: picked.files, skipped: picked.skipped, password, allowCode: Boolean(v['allow-code']), waitMs: minutes * 60_000 }, emit);
    if (!json) io.out(`Sending ${picked.files.length === 1 ? '1 file' : picked.files.length + ' files'} (${size(picked.files.reduce((n, f) => n + f.size, 0))}).`);
  } else if (command === 'ask') {
    if (args.positionals.length > 0) return usage('Ask takes no file names. Say what you need with --note.');
    const minutes = v.timeout === undefined ? 30 : Number(v.timeout);
    if (!Number.isFinite(minutes) || minutes < 0) return usage('--timeout takes a number of minutes (0 waits for ever).');
    let maxSize: number | undefined;
    if (v['max-size'] !== undefined) {
      const n = parseSize(v['max-size']);
      if (n === null) return usage('--max-size takes a size such as 500MB or 2GB.');
      maxSize = n;
    }
    const maxFiles = v['max-files'] === undefined ? 1000 : Number(v['max-files']);
    if (!Number.isInteger(maxFiles) || maxFiles < 1) return usage('--max-files takes a whole number of files, 1 or more.');
    run = ask(env, { note: v.note, dest: resolve(v.to ?? '.'), maxSize, maxFiles, password, allowCode: Boolean(v['allow-code']), waitMs: minutes * 60_000 }, emit);
    if (!json) io.out('Asking for files' + (cleanNote(v.note ?? '') ? `: "${cleanNote(v.note ?? '')}"` : '') + '.');
  } else {
    const [what] = args.positionals;
    if (!what || args.positionals.length > 1) return usage('Give the link or the nine-digit code of one room.');
    const door = doorOf(what, origin);
    if (!door) return usage('That is not a link from this site or a nine-digit code.');
    let maxSize: number | undefined;
    if (v['max-size'] !== undefined) {
      const n = parseSize(v['max-size']);
      if (n === null) return usage('--max-size takes a size such as 500MB or 2GB.');
      maxSize = n;
    }
    run = receive(env, { target: door, dest: resolve(v.to ?? '.'), maxSize, overwrite: Boolean(v.overwrite), password }, emit);
  }
  const stop = io.onInterrupt?.(() => run.cancel());
  const result: Result = await run.done;
  stop?.();
  if (io.tty && !json) io.out('\x1b[2K');
  if (result.outcome === 'finished') {
    if (!json) io.out(reasonText('finished'));
  } else if (!json) io.err(result.message);
  return EXIT[result.outcome];
}
