/**
 * The program's maker of small pictures of photos (docs/PROTOCOL.md, "Previews"): what the page's maker (web/src/transfer/preview-make.ts) is for a browser. The engine asks it for one file at a time,
 * and it answers from the file on disk. The decoding is slow in plain JavaScript (a few seconds for a big photo), so the built program does it in a worker thread, started when the first picture is
 * wanted and let go a few seconds after the last: the connection, the other device's questions and the transfer itself are never held up. A picture that takes longer than the engine's time for one
 * (PREVIEW_ONE_MS) stops the worker, which starts again for the next one.
 */
import { Worker } from 'node:worker_threads';
import { PREVIEW_ONE_MS, type PreviewLimits } from '../../shared/config.ts';
import type { Sendable } from '../../web/src/transfer/engine.ts';
import type { PreviewImage } from '../../web/src/transfer/preview.ts';
import type { PreviewDone, PreviewJob } from './preview-worker.ts';

// Put in at build time (scripts/build-cli.mjs): the worker's code, built from cli/src/preview-worker.ts. Without it (tests, a program run from source) the same work is done in this thread.
declare const __FD_PREVIEW_WORKER__: string[] | undefined;

/** How long the worker is kept after its last picture. */
const KEEP_MS = 5000;
/** A worker may not hold more than this of its own memory (the photo's pixels live outside of it, and are bounded by the size the maker accepts). */
const WORKER_MEMORY_MB = 512;

let override: string | null = null;
let oneMs = PREVIEW_ONE_MS;
let worker: Worker | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
let ids = 0;
/** The pictures are made one after the other: a picture the sender gave up on may still be decoding, and the next one waits for it. */
let queue: Promise<unknown> = Promise.resolve();

/** For tests: run the worker with this code instead of the built-in one (null: back to the default), and give up on a picture after `ms`. */
export function useWorkerCode(code: string | null, ms = PREVIEW_ONE_MS): void {
  override = code;
  oneMs = ms;
  stopWorker();
}

export function stopWorker(): void {
  clearTimeout(idle);
  const w = worker;
  worker = null;
  if (w) void w.terminate();
}

let built: string | null | undefined;
/** The worker's code the build put in, or null (run from source). The build writes it in short pieces, one to a line (a line of the packed program may not be long). */
function builtWorker(): string | null {
  if (built === undefined) built = typeof __FD_PREVIEW_WORKER__ === 'undefined' ? null : __FD_PREVIEW_WORKER__.join('');
  return built;
}

function workerCode(): string | null {
  return override ?? builtWorker();
}

function inWorker(code: string, abs: string, limits: PreviewLimits): Promise<PreviewImage | null> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = worker ??= new Worker(code, { eval: true, workerData: { fdPreviewWorker: true }, resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } });
      w.unref(); // a worker never keeps the program alive
    } catch {
      return resolve(null);
    }
    clearTimeout(idle);
    const id = ++ids;
    const finish = (image: PreviewImage | null, keep: boolean): void => {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onGone);
      w.off('exit', onGone);
      if (!keep) {
        if (worker === w) worker = null;
        void w.terminate();
      } else {
        idle = setTimeout(stopWorker, KEEP_MS);
        idle.unref();
      }
      resolve(image);
    };
    const onMessage = (m: PreviewDone): void => {
      if (m.id === id) finish(m.image, true);
    };
    const onGone = (): void => finish(null, false);
    const timer = setTimeout(() => finish(null, false), oneMs);
    w.on('message', onMessage);
    w.on('error', onGone);
    w.on('exit', onGone);
    w.postMessage({ id, abs, limits } satisfies PreviewJob);
  });
}

async function inThread(abs: string, limits: PreviewLimits): Promise<PreviewImage | null> {
  // the built program has its worker and never decodes in its own thread: this is for tests and a run from source
  if (builtWorker() === null) {
    const { pictureOfFile } = await import('./preview-worker.ts');
    return pictureOfFile(abs, limits);
  }
  return null;
}

/** The small picture of a file the program sends (one that has a place on disk), or null: no picture of it. Never throws. */
export function makePreview(src: Sendable, limits: PreviewLimits): Promise<PreviewImage | null> {
  const abs = (src as { abs?: unknown }).abs;
  if (typeof abs !== 'string') return Promise.resolve(null);
  const mine = queue.then(() => {
    const code = workerCode();
    return code ? inWorker(code, abs, limits) : inThread(abs, limits);
  });
  queue = mine.catch(() => null);
  return mine.catch(() => null);
}
