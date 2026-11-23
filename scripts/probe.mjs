import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, release, version } from 'node:os';
import { join } from 'node:path';
console.log('os', release(), version(), process.version);
const dir = mkdtempSync(join(tmpdir(), 'probe-'));
const js = join(dir, 'w.mjs');
writeFileSync(js, "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], 'ran ' + JSON.stringify(process.argv.slice(2)));");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tryit(name, fn) {
  const out = join(dir, name + '.txt');
  rmSync(out, { force: true });
  let info = '';
  try { info = String(fn(out)); } catch (e) { info = 'threw ' + e.message; }
  for (let i = 0; i < 100 && !existsSync(out); i++) await sleep(100);
  console.log(name.padEnd(28), existsSync(out) ? 'RAN' : 'did not run', info);
}
const node = process.execPath;
await tryit('conhost-headless-verbatim', (out) => { const c = spawn('conhost.exe', ['--headless "' + node + '" "' + js + '" "' + out + '"'], { windowsVerbatimArguments: true, stdio: 'ignore' }); c.on('error', (e) => console.log('err', e.message)); c.on('exit', (code) => console.log('conhost exit', code)); return 'spawned'; });
await tryit('conhost-headless-args', (out) => { const r = spawnSync('conhost.exe', ['--headless', node, js, out], { stdio: 'ignore', timeout: 20000 }); return 'status ' + r.status + ' ' + (r.error?.message ?? ''); });
await tryit('conhost-headless-ps', (out) => { const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath conhost.exe -ArgumentList '--headless','" + node + "','" + js + "','" + out + "' -Wait"], { stdio: 'ignore', timeout: 30000 }); return 'status ' + r.status; });
await tryit('node-direct-hidden', (out) => { const c = spawn(node, [js, out], { stdio: 'ignore', windowsHide: true, detached: true }); c.unref(); return 'spawned'; });
await tryit('cmd-start-b', (out) => { spawn('cmd.exe', ['/d', '/c', 'start "" /b "' + node + '" "' + js + '" "' + out + '"'], { stdio: 'ignore', windowsVerbatimArguments: true }).on('error', () => {}); return 'spawned'; });
await tryit('wscript-vbs', (out) => { const vbs = join(dir, 'l.vbs'); writeFileSync(vbs, 'CreateObject("WScript.Shell").Run """' + node + '"" ""' + js + '"" ""' + out + '""", 0, False\r\n'); spawn('wscript.exe', ['//B', '//Nologo', vbs], { stdio: 'ignore' }).on('error', () => {}); return 'spawned'; });
