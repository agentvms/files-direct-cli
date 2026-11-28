/**
 * Who shows the window's page (files-direct-30, files-direct-60). One place for the three ways, so `open` and `listen` cannot drift apart:
 *  - the app's own window (--shell-window, files-direct-60): the Files Direct app (the Mac menu-bar program, the Windows tray program) shows the page in a window of its own. The engine
 *    starts no browser; it prints one line with the page's address, and the app opens that address and nothing else. The app ends the window by pressing the page's own Close, the way
 *    the person would, and the run ends with it; a program that is gone is noticed by the page's own idle watch (cli/src/window.ts).
 *  - no window (--no-window): the address is printed for whoever wants it (a check, a script).
 *  - the default: an app-style window of a browser that is already on the computer, else the default browser (cli/src/browser.ts).
 */
import { launchWindow, type WindowHandle } from './browser.ts';
import type { Io } from './cli.ts';
import type { Desk, DeskServer } from './window.ts';

export interface ShowOptions {
  noWindow: boolean;
  /** The app shows the page in its own window: print the address, start no browser. */
  shell: boolean;
  json: boolean;
}

/** The window's run is over (the page's Close was pressed, or the window was abandoned): in the app's own window the app is told, so it closes the window. A listener goes on after this; an `open` ends. */
export function windowEnded(server: DeskServer, o: ShowOptions, io: Io): void {
  if (o.shell) io.out(JSON.stringify({ event: 'closed', url: server.url, at: new Date().toISOString() }));
}

/** Shows the page as asked, and returns what must be closed with it (null when nothing was started). A window that closes by itself ends the desk. */
export async function showWindow(server: DeskServer, desk: Desk, o: ShowOptions, io: Io): Promise<WindowHandle | null> {
  const at = new Date().toISOString();
  if (o.shell) {
    // always one JSON line, whatever --json says: the app reads it
    io.out(JSON.stringify({ event: 'window', url: server.url, shell: true, at }));
    return null;
  }
  if (o.noWindow) {
    io.out(o.json ? JSON.stringify({ event: 'window', url: server.url, at }) : `Window: ${server.url}`);
    return null;
  }
  const handle = await (io.window ?? launchWindow)(server.url);
  if (!handle) {
    io.err('No browser was found to show the window. Open this address in a browser on this computer: ' + server.url);
    return null;
  }
  void handle.closed.then(() => desk.abandon());
  if (o.json) io.out(JSON.stringify({ event: 'window', url: server.url, how: handle.how, ...(handle.pid === undefined ? {} : { pid: handle.pid }), at }));
  return handle;
}
