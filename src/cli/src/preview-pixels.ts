/**
 * The small picture of a photo, made in plain JavaScript so the program needs nothing installed (docs/PROTOCOL.md, "Previews"): the same job as the page's own maker (web/src/transfer/preview-make.ts)
 * with what a browser does for it done here: decode JPEG, PNG or GIF (its first picture), turn it the way the camera held it, scale it down to the route's edge, lay it on white, and keep it
 * as a JPEG that fits the byte limit. Anything else (WebP, AVIF, HEIC, a broken file) gives null: that file simply has no preview. No file system and no timers in here: it takes the file's bytes.
 */
import jpeg from 'jpeg-js';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';
import type { PreviewLimits } from '../../shared/config.ts';
import { type PreviewImage, fitWithin, readSize } from '../../web/src/transfer/preview.ts';

/**
 * A photo with more pixels than this is not decoded at all: this decoder holds the whole photo while it works (about 570 MB at its peak for a 12 million pixel JPEG, about a gigabyte for 24 million,
 * measured on the Epic VM) and takes longer than a preview's time (PREVIEW_ONE_MS) for the biggest. The page's maker is not bound by this: a browser decodes a big photo already small.
 */
export const MAX_SOURCE_PIXELS = 16_000_000;

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** What kind of picture these first bytes are, by the bytes and not by the name. */
export function kindOf(b: Uint8Array): 'jpeg' | 'png' | 'gif' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  return null;
}

/** How the camera held a JPEG (EXIF orientation 1 to 8; 1 when the file does not say). */
export function orientationOf(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 2;
  while (at + 4 < b.length && b[at] === 0xff) {
    const marker = b[at + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // the picture itself starts
    const length = v.getUint16(at + 2);
    if (marker === 0xe1 && length >= 16 && b[at + 4] === 0x45 && b[at + 5] === 0x78 && b[at + 6] === 0x69 && b[at + 7] === 0x66) {
      const tiff = at + 10;
      const little = b[tiff] === 0x49;
      const u16 = (o: number) => v.getUint16(o, little);
      if (tiff + 8 > b.length || u16(tiff + 2) !== 42) return 1;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      if (ifd + 2 > b.length) return 1;
      const n = u16(ifd);
      for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= b.length; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) {
          const o = u16(e + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    if (length < 2) break;
    at += 2 + length;
  }
  return 1;
}

function decode(b: Uint8Array, kind: 'jpeg' | 'png' | 'gif'): Rgba | null {
  if (kind === 'jpeg') {
    const d = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_SOURCE_PIXELS / 1e6, maxMemoryUsageInMB: 1200, tolerantDecoding: true });
    return { width: d.width, height: d.height, data: d.data };
  }
  if (kind === 'png') {
    const d = PNG.sync.read(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
    return { width: d.width, height: d.height, data: d.data };
  }
  const g = new GifReader(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  const data = new Uint8Array(g.width * g.height * 4);
  g.decodeAndBlitFrameRGBA(0, data);
  return { width: g.width, height: g.height, data };
}

/** The picture scaled to dw by dh by averaging the pixels each new one covers (a smooth, even result for a big step down), laid on white where it is see-through. Opaque RGBA out. */
export function scale(src: Rgba, dw: number, dh: number): Rgba {
  const { width: sw, height: sh, data } = src;
  const out = new Uint8Array(dw * dh * 4);
  const xs = sw / dw; // source columns for one output column
  const ys = sh / dh; // source rows for one output row
  // one source row at a time is shrunk across (to dw columns), then added to the output rows it covers
  const row = new Float32Array(dw * 3);
  const acc = new Float32Array(dw * 3);
  let outY = 0;
  let filled = 0; // how much of the current output row's height has been added
  const flush = (): void => {
    const o = outY * dw * 4;
    for (let x = 0; x < dw; x++) {
      out[o + x * 4] = Math.round(acc[x * 3]!);
      out[o + x * 4 + 1] = Math.round(acc[x * 3 + 1]!);
      out[o + x * 4 + 2] = Math.round(acc[x * 3 + 2]!);
      out[o + x * 4 + 3] = 255;
    }
    acc.fill(0);
    outY++;
    filled = 0;
  };
  for (let y = 0; y < sh; y++) {
    row.fill(0);
    const base = y * sw * 4;
    for (let x = 0; x < sw; x++) {
      const a = data[base + x * 4 + 3]! / 255;
      const r = data[base + x * 4]! * a + 255 * (1 - a);
      const g = data[base + x * 4 + 1]! * a + 255 * (1 - a);
      const b = data[base + x * 4 + 2]! * a + 255 * (1 - a);
      // this column covers [x, x+1) of the source: split it between the output columns it falls in
      const from = x / xs;
      const to = (x + 1) / xs;
      let cx = Math.floor(from);
      while (cx < dw && cx < to) {
        const part = Math.min(to, cx + 1) - Math.max(from, cx);
        if (part > 0) {
          const at = cx * 3;
          row[at] = row[at]! + r * part;
          row[at + 1] = row[at + 1]! + g * part;
          row[at + 2] = row[at + 2]! + b * part;
        }
        cx++;
      }
    }
    // this row covers [y, y+1) of the source: split it between the output rows it falls in
    let from = y / ys;
    const to = (y + 1) / ys;
    while (from < to - 1e-9 && outY < dh) {
      const room = outY + 1 - from;
      const part = Math.min(to - from, room);
      for (let i = 0; i < dw * 3; i++) acc[i] = acc[i]! + row[i]! * part;
      filled += part;
      from += part;
      if (outY + 1 - from < 1e-9) flush();
    }
  }
  if (outY < dh && filled > 0) flush();
  while (outY < dh) {
    out.copyWithin(outY * dw * 4, (outY - 1) * dw * 4, outY * dw * 4);
    outY++;
  }
  return { width: dw, height: dh, data: out };
}

/** Turns a picture the way EXIF orientation 2 to 8 says (1 is as it is). */
export function orient(p: Rgba, o: number): Rgba {
  if (o === 1) return p;
  const { width: w, height: h, data } = p;
  const swap = o >= 5;
  const [dw, dh] = swap ? [h, w] : [w, h];
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // where the pixel (x, y) of the file lands in the upright picture
      let nx = x;
      let ny = y;
      if (o === 2) nx = w - 1 - x;
      else if (o === 3) [nx, ny] = [w - 1 - x, h - 1 - y];
      else if (o === 4) ny = h - 1 - y;
      else if (o === 5) [nx, ny] = [y, x];
      else if (o === 6) [nx, ny] = [h - 1 - y, x];
      else if (o === 7) [nx, ny] = [h - 1 - y, w - 1 - x];
      else [nx, ny] = [y, w - 1 - x];
      out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * dw + nx) * 4);
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Qualities tried at each size, then a smaller picture, until it fits the byte limit (as the page's maker does). Null when nothing fits. */
function fit(picture: Rgba, limits: PreviewLimits): PreviewImage | null {
  let p = picture;
  for (let round = 0; round < 3; round++) {
    for (const quality of [72, 55, 40]) {
      const bytes = jpeg.encode({ data: p.data, width: p.width, height: p.height }, quality).data;
      if (bytes.length > 0 && bytes.length <= limits.bytes) return { type: 'image/jpeg', w: p.width, h: p.height, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) };
    }
    const next = fitWithin(p.width, p.height, Math.max(16, Math.round(Math.max(p.width, p.height) * 0.75)));
    p = scale(p, next.w, next.h);
  }
  return null;
}

/** The small picture of this file's bytes, or null (not a picture this can read, too big, broken). Never throws. */
export function smallPicture(file: Uint8Array, limits: PreviewLimits): PreviewImage | null {
  try {
    const kind = kindOf(file);
    if (!kind) return null;
    const size = readSize(file);
    if (!size || size.w < 1 || size.h < 1 || size.w * size.h > MAX_SOURCE_PIXELS) return null;
    const o = kind === 'jpeg' ? orientationOf(file) : 1;
    const full = decode(file, kind);
    if (!full || full.width < 1 || full.height < 1 || full.width * full.height > MAX_SOURCE_PIXELS) return null;
    const upright = o >= 5 ? { w: full.height, h: full.width } : { w: full.width, h: full.height };
    const to = fitWithin(upright.w, upright.h, limits.edge);
    const [dw, dh] = o >= 5 ? [to.h, to.w] : [to.w, to.h];
    const small = scale(full, dw, dh);
    return fit(orient(small, o), limits);
  } catch {
    return null;
  }
}
