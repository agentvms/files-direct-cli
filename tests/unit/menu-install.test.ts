import { describe, expect, it } from 'vitest';
import { MAC_WORKFLOW, MENU_TEXT, WIN_KEYS, WIN_SENDTO, installMenu, macInfoPlist, macWorkflow, menuStatus, removeMenu, windowsRegText, type Launch, type MenuEffects } from '../../src/cli/src/menu.ts';

// files-direct-30, done-when 2: what menu install writes, and that menu remove takes out exactly that and nothing else.
// The machine here is made up: a table of files and a table of registry keys, with a few things in them that are not ours.

const LAUNCH: Launch = { node: '/Users/ann/.nvm/versions/node/v22.22.0/bin/node', script: "/Users/ann/.nvm/versions/node/v22.22.0/lib/node_modules/files-direct/dist/files-direct.mjs" };
const WIN: Launch = { node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\Ann\\AppData\\Roaming\\npm\\node_modules\\files-direct\\dist\\files-direct.mjs' };

function machine(platform: string) {
  const files = new Map<string, string>([
    ['/Users/ann/Library/Services/Other.workflow/Contents/Info.plist', 'someone else'],
    ['/Users/ann/Library/Services/' + MAC_WORKFLOW + '.bak', 'not ours either'],
    ['C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo\\Notes.lnk', 'someone else'],
  ]);
  const keys = new Map<string, string>([
    ['HKCU\\Software\\Classes\\*\\shell\\OtherTool', 'someone else'],
    ['HKCU\\Software\\Classes\\Directory\\shell\\OtherTool\\command', 'someone else'],
    ['HKCU\\Software\\Classes\\*\\shell\\FilesDirectory', 'a key whose name starts like ours'],
  ]);
  let refreshed = 0;
  const fx: MenuEffects = {
    platform,
    home: '/Users/ann',
    sendToDir: 'C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo',
    async writeFile(p, c) { files.set(p, String(c)); },
    async removePath(p) { for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); },
    async exists(p) { return [...files.keys()].some((k) => k === p || k.startsWith(p + '/')); },
    async regImport(text) {
      const re = /^\[HKEY_CURRENT_USER\\(.+)\]$/gm;
      for (const m of text.matchAll(re)) keys.set('HKCU\\' + m[1], 'ours');
    },
    async regDelete(k) { for (const x of [...keys.keys()]) if (x === k || x.startsWith(k + '\\')) keys.delete(x); },
    async regExists(k) { return [...keys.keys()].some((x) => x === k || x.startsWith(k + '\\')); },
    async shortcut(p, a) { files.set(p, 'shortcut ' + a); },
    async refreshServices() { refreshed++; },
  };
  return { fx, files, keys, refreshed: () => refreshed, snapshot: () => JSON.stringify([[...files.entries()].sort(), [...keys.entries()].sort()]) };
}

describe('on a Mac', () => {
  it('installs one workflow in the person\'s own Services folder, and tells the system', async () => {
    const m = machine('darwin');
    const lines = await installMenu(LAUNCH, m.fx);
    expect(lines).toHaveLength(1);
    const ours = [...m.files.keys()].filter((k) => k.includes(MAC_WORKFLOW + '/')).sort();
    expect(ours).toEqual([`/Users/ann/Library/Services/${MAC_WORKFLOW}/Contents/Info.plist`, `/Users/ann/Library/Services/${MAC_WORKFLOW}/Contents/document.wflow`]);
    expect(m.refreshed()).toBe(1);
    expect(await menuStatus(m.fx)).toMatchObject({ installed: true });
  });

  it('writes a workflow Finder reads: the menu text, files and folders, arguments in, the program quoted', () => {
    const info = macInfoPlist();
    expect(info).toContain(`<string>${MENU_TEXT}</string>`);
    expect(info).toContain('com.apple.finder');
    expect(info).toContain('public.item');
    const wf = macWorkflow(LAUNCH);
    expect(wf).toContain('<key>inputMethod</key>\n\t\t\t\t\t<integer>1</integer>'); // chosen files come in as arguments
    expect(wf).toContain('com.apple.Automator.servicesMenu');
    expect(wf).toContain("open -- &quot;$@&quot;");
    expect(wf).toContain("node='/Users/ann/.nvm/versions/node/v22.22.0/bin/node'");
    // a program path with a quote in it stays inside its quotes, in the plist too
    expect(macWorkflow({ node: "/Users/o'neil/bin/node", script: '/a & b/<x>.mjs' })).toContain("node='/Users/o'\\''neil/bin/node'");
    expect(macWorkflow({ node: "/n", script: '/a & b/<x>.mjs' })).toContain('/a &amp; b/&lt;x&gt;.mjs');
  });

  it('removes exactly the workflow, and leaves other Services alone; removing twice is fine', async () => {
    const m = machine('darwin');
    const before = m.snapshot();
    await installMenu(LAUNCH, m.fx);
    expect((await removeMenu(m.fx)).length).toBe(1);
    expect(m.snapshot()).toBe(before);
    expect(await removeMenu(m.fx)).toEqual([]);
    expect(m.snapshot()).toBe(before);
    expect(await menuStatus(m.fx)).toMatchObject({ installed: false });
  });

  it('installing again replaces the workflow: no file of the first one is left', async () => {
    const m = machine('darwin');
    await installMenu(LAUNCH, m.fx);
    m.files.set(`/Users/ann/Library/Services/${MAC_WORKFLOW}/Contents/stale`, 'old');
    await installMenu({ ...LAUNCH, node: '/usr/local/bin/node' }, m.fx);
    expect([...m.files.keys()].filter((k) => k.endsWith('/stale'))).toEqual([]);
    expect(m.files.get(`/Users/ann/Library/Services/${MAC_WORKFLOW}/Contents/document.wflow`)).toContain("/usr/local/bin/node");
  });
});

describe('on Windows', () => {
  it('writes the entry for files and for folders, each with its command, in the current user\'s part of the registry only, and a Send to shortcut', async () => {
    const text = windowsRegText(WIN);
    expect(text.split('\r\n')[0]).toBe('Windows Registry Editor Version 5.00');
    const headings = [...text.matchAll(/^\[(.+)\]$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\FilesDirect',
      'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\FilesDirect\\command',
      'HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\FilesDirect',
      'HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\FilesDirect\\command',
    ]);
    expect(text).not.toMatch(/HKEY_LOCAL_MACHINE|HKLM|HKEY_CLASSES_ROOT/);
    expect(text).toContain('@="Send with Files Direct"');
    // the command, as the file holds it: backslashes and quotes doubled
    expect(text).toContain('@="conhost.exe --headless \\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" ');
    expect(text).toContain('open --gather -- \\"%1\\""');
    const m = machine('win32');
    const lines = await installMenu(WIN, m.fx);
    expect(lines).toHaveLength(2);
    expect([...m.keys.keys()].filter((k) => /FilesDirect($|\\)/.test(k)).sort()).toEqual(WIN_KEYS.flatMap((k) => [k, k + '\\command']).sort());
    expect(m.files.get('C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo\\' + WIN_SENDTO)).toContain('--headless');
    expect(await menuStatus(m.fx)).toMatchObject({ installed: true });
  });

  it('removes exactly what it wrote: a key and a shortcut that are someone else\'s stay, a key that starts like ours stays', async () => {
    const m = machine('win32');
    const before = m.snapshot();
    await installMenu(WIN, m.fx);
    expect(m.snapshot()).not.toBe(before);
    const gone = await removeMenu(m.fx);
    expect(gone.length).toBe(3);
    expect(m.snapshot()).toBe(before);
    expect(await removeMenu(m.fx)).toEqual([]);
  });

  it('removes what is left of a half-done install, whether or not the program is still there', async () => {
    const m = machine('win32');
    await installMenu(WIN, m.fx);
    m.files.delete('C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo\\' + WIN_SENDTO);
    expect(await menuStatus(m.fx)).toMatchObject({ installed: false });
    await removeMenu(m.fx);
    expect([...m.keys.keys()].filter((k) => /FilesDirect($|\\)/.test(k))).toEqual([]);
  });

  it('writes nothing when the program path cannot be used', async () => {
    const m = machine('win32');
    const before = m.snapshot();
    await expect(installMenu({ ...WIN, node: 'C:\\100%\\node.exe' }, m.fx)).rejects.toThrow(/%/);
    expect(m.snapshot()).toBe(before);
  });
});

describe('on any other system', () => {
  it('says plainly that the menu is for a Mac or Windows and changes nothing', async () => {
    const m = machine('linux');
    const before = m.snapshot();
    await expect(installMenu(LAUNCH, m.fx)).rejects.toThrow(/Mac or a Windows/);
    await expect(removeMenu(m.fx)).rejects.toThrow(/Mac or a Windows/);
    expect(m.snapshot()).toBe(before);
  });
});
