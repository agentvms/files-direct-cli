/**
 * The part of making a preview that does the heavy work: read the photo from disk and make its small picture (cli/src/preview-pixels.ts). In the built program this runs in a worker thread
 * (cli/src/preview-node.ts starts it), so decoding a big photo never holds up the connection; in tests and anywhere the worker is not built in, the same function is called in the program's own thread.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PREVIEW_SOURCE_MAX_BYTES, type PreviewLimits } from '../../shared/config.ts';
import type { PreviewImage } from '../../web/src/transfer/preview.ts';
import { smallPicture } from './preview-pixels.ts';

/** The whole file, or null when it is not a plain file, is empty, or is bigger than a preview is made from. A link is never followed (the file was found without following one). */
export function readPhoto(abs: string): Uint8Array | null {
  let fd = -1;
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > PREVIEW_SOURCE_MAX_BYTES) return null;
    const out = new Uint8Array(st.size);
    let at = 0;
    while (at < out.length) {
      const n = readSync(fd, out, at, out.length - at, at);
      if (n === 0) return null; // the file got shorter while it was read
      at += n;
    }
    return out;
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export function pictureOfFile(abs: string, limits: PreviewLimits): PreviewImage | null {
  const bytes = readPhoto(abs);
  return bytes ? smallPicture(bytes, limits) : null;
}

/** What the program's thread sends the worker, and what comes back. */
export interface PreviewJob {
  id: number;
  abs: string;
  limits: PreviewLimits;
}
export interface PreviewDone {
  id: number;
  image: PreviewImage | null;
}

// Started as a worker (workerData says so; any other thread, a test runner's included, is left alone): answer each job with its picture.
if (!isMainThread && parentPort && (workerData as { fdPreviewWorker?: boolean } | null)?.fdPreviewWorker === true) {
  const port = parentPort;
  port.on('message', (job: PreviewJob) => {
    const image = pictureOfFile(job.abs, job.limits);
    port.postMessage({ id: job.id, image } satisfies PreviewDone);
  });
}
