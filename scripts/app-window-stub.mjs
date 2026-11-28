// The stand-in engine of the check of the app's own window (files-direct-60), run by app-check.mjs (mac-window, win-window) on GitHub's own machines. The check puts it in the place of
// the app's engine file (the real one stays beside it as files-direct-real.mjs) and puts its settings in window-stub.json beside it. It answers the app the way the real engine does for a
// window of the app: one line with the address of a page on 127.0.0.1 and a secret word in its path, and a line when the meeting is over. The page is a few lines of its own, so that what
// the app's window does with it can be seen from outside: who asked for it (the web engine's name is in the request), whether the window stays on it when the page sends it somewhere
// else, and what is pressed when the window is closed. Every other command (menu, app, update) is the real engine, unchanged.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(readFileSync(fileURLToPath(new URL('./window-stub.json', import.meta.url)), 'utf8'));
const args = process.argv.slice(2);
const say = (what, more = {}) => appendFileSync(config.log, JSON.stringify({ what, at: Date.now(), ...more }) + '\n');

if (args[0] !== 'open' && args[0] !== 'listen') {
  await import(new URL('./files-direct-real.mjs', import.meta.url).href);
} else {
  say('started', { args });
  // the paths of a right-click come on the standard input: nothing here needs them, but they are read, as the real engine reads them
  process.stdin.on('data', () => {});
  process.stdin.on('error', () => {});
  if (args[0] === 'listen') setInterval(() => {}, 1000);
  else run(args.includes('--shell-window'));
}

function run(shell) {
  const word = randomBytes(12).toString('base64url');
  const base = '/w/' + word + '/';
  let url = '';
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    say('closed');
    console.log(JSON.stringify({ event: 'closed', url, at: new Date().toISOString() }));
    setTimeout(() => process.exit(0), 300);
  };
  const page =
    '<!doctype html><meta charset="utf-8"><title>Files Direct</title><main>stand-in</main><script>' +
    "setInterval(function () { fetch('ping').catch(function () {}); }, 300);" +
    'setTimeout(function () { location.href = ' + JSON.stringify(config.outside) + '; }, 2500);' +
    '</script>';
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === base && req.method === 'GET') {
      say('page', { ua: req.headers['user-agent'] ?? '' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(page);
    }
    if (path === base + 'ping') {
      say('ping');
      return void res.end('ok');
    }
    if (path === base + 'act' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        say('act', { body, origin: req.headers.origin ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        try {
          if (JSON.parse(body).do === 'close') end();
        } catch {
          /* not JSON: nothing to do */
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1', () => {
    url = 'http://127.0.0.1:' + server.address().port + base;
    say('ready', { url, shell });
    console.log(JSON.stringify({ event: 'window', url, ...(shell ? { shell: true } : {}), at: new Date().toISOString() }));
    // a window the app does not show has no one to close it: this one ends by itself
    if (!shell) setTimeout(() => process.exit(0), 8000);
    // the meeting is over, as the real engine says it when the page's Close is pressed: the check asks for it by making a file
    setInterval(() => {
      if (config.end && existsSync(config.end)) end();
    }, 200);
  });
}
