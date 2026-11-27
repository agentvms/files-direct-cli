// The Mac disk image's window (files-direct-56): the app on the left, an Applications shortcut on the right, an arrow between them, sized like common Mac apps.
// Everything is made here with no dependency, so the layout is the same on every machine and a test on Linux can read it back:
//   - the folder that hdiutil packs (the app, the "Applications" link, a hidden .background folder, and the .DS_Store the Finder reads the window from),
//   - the .DS_Store itself (a "buddy allocator" file holding one B-tree of records), the binary property lists inside it, and the Finder alias of the background picture,
//   - the background picture: a TIFF holding the 1x and the @2x drawing (the Finder takes the sharper one on a Retina screen, as "tiffutil -cathidpicheck" would make it).
// On the macOS machine hdiutil only packs the folder. What the Finder does with the result on a real screen is measured by a person on a Mac (docs/DESKTOP.md).
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_NAME = 'Files Direct.app';
export const VOLUME_NAME = 'Files Direct';
export const BACKGROUND_DIR = '.background';
export const BACKGROUND_FILE = 'background.tiff';
/**
 * The window, as the Finder is told: 660 by 400 of content (the size of the picture), a 22-point title bar on top of it, the icons 128 points square with their names 12 points
 * under them, the app's centre at (180, 190) and the shortcut's at (480, 190): one row, the arrow in the middle.
 */
export const LAYOUT = {
  width: 660,
  height: 400,
  titleBar: 22,
  x: 200,
  y: 120,
  iconSize: 128,
  textSize: 12,
  icons: { [APP_NAME]: { x: 180, y: 190 }, Applications: { x: 480, y: 190 } },
};

// ---- the background picture ------------------------------------------------------------------------------------------------------------

const CANVAS = [0xf6, 0xf4, 0xee];
const PINE = [0x26, 0x5c, 0x47];
const PINE_SOFT = [0xe5, 0xf0, 0xeb];

/** Distance from point (px, py) to the segment a-b. */
function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The drawing at a scale (1 or 2): our canvas colour, a soft round under each icon, and a pine arrow from the app to Applications. Returns RGB bytes, row by row. */
export function backgroundRgb(scale = 1) {
  const w = LAYOUT.width * scale;
  const h = LAYOUT.height * scale;
  const out = Buffer.alloc(w * h * 3);
  const { x: ax, y: ay } = LAYOUT.icons[APP_NAME];
  const { x: bx } = LAYOUT.icons.Applications;
  const shaftFrom = ax + 108;
  const tip = bx - 106;
  const half = 4.5; // half the line's width
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px + 0.5) / scale;
      const y = (py + 0.5) / scale;
      let rgb = CANVAS;
      // a soft round under each icon, so a name under it reads on a calm ground
      for (const cx of [ax, bx]) {
        const d = Math.hypot(x - cx, y - ay) - 82;
        const cover = Math.max(0, Math.min(1, 0.5 - d * scale));
        if (cover > 0) rgb = rgb.map((c, i) => c * (1 - cover) + PINE_SOFT[i] * cover);
      }
      // the arrow: a line with a round end, and a head of two strokes
      const d = Math.min(segment(x, y, shaftFrom, ay, tip, ay), segment(x, y, tip, ay, tip - 22, ay - 22), segment(x, y, tip, ay, tip - 22, ay + 22)) - half;
      const cover = Math.max(0, Math.min(1, 0.5 - d * scale));
      if (cover > 0) rgb = rgb.map((c, i) => c * (1 - cover) + PINE[i] * cover);
      const o = (py * w + px) * 3;
      out[o] = Math.round(rgb[0]);
      out[o + 1] = Math.round(rgb[1]);
      out[o + 2] = Math.round(rgb[2]);
    }
  }
  return out;
}

/** A TIFF with the 1x picture (72 dots per inch) and the @2x picture (144), uncompressed RGB: the form the Finder takes for a background that is sharp on Retina screens. */
export function backgroundTiff() {
  const pages = [1, 2].map((scale) => ({ w: LAYOUT.width * scale, h: LAYOUT.height * scale, dpi: 72 * scale, pixels: backgroundRgb(scale) }));
  const entries = 12;
  const ifdSize = 2 + entries * 12 + 4;
  const extra = 6 + 8 + 8; // bits per sample, x and y resolution
  let cursor = 8;
  const at = pages.map((p) => {
    const ifd = cursor;
    const data = ifd + ifdSize;
    const strip = data + extra;
    cursor = strip + p.pixels.length + (p.pixels.length & 1);
    return { ifd, data, strip };
  });
  const out = Buffer.alloc(cursor);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(at[0].ifd, 4);
  pages.forEach((p, i) => {
    const a = at[i];
    const tags = [
      [256, 4, 1, p.w],
      [257, 4, 1, p.h],
      [258, 3, 3, a.data],
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 4, 1, a.strip],
      [277, 3, 1, 3],
      [278, 4, 1, p.h],
      [279, 4, 1, p.pixels.length],
      [282, 5, 1, a.data + 6],
      [283, 5, 1, a.data + 14],
      [296, 3, 1, 2],
    ];
    out.writeUInt16LE(tags.length, a.ifd);
    tags.forEach(([tag, type, count, value], k) => {
      const e = a.ifd + 2 + k * 12;
      out.writeUInt16LE(tag, e);
      out.writeUInt16LE(type, e + 2);
      out.writeUInt32LE(count, e + 4);
      if (type === 3 && count === 1) out.writeUInt16LE(value, e + 8);
      else out.writeUInt32LE(value, e + 8);
    });
    out.writeUInt32LE(i === 0 ? at[1].ifd : 0, a.ifd + 2 + tags.length * 12);
    for (let c = 0; c < 3; c++) out.writeUInt16LE(8, a.data + c * 2);
    out.writeUInt32LE(p.dpi, a.data + 6);
    out.writeUInt32LE(1, a.data + 10);
    out.writeUInt32LE(p.dpi, a.data + 14);
    out.writeUInt32LE(1, a.data + 18);
    p.pixels.copy(out, a.strip);
  });
  return out;
}

/** The pictures of a TIFF written by backgroundTiff: width, height, dots per inch and the RGB bytes of each. */
export function readTiff(buf) {
  if (buf.toString('latin1', 0, 2) !== 'II' || buf.readUInt16LE(2) !== 42) throw new Error('not a little-endian TIFF');
  const pages = [];
  for (let ifd = buf.readUInt32LE(4); ifd; ) {
    const n = buf.readUInt16LE(ifd);
    const t = {};
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      const type = buf.readUInt16LE(e + 2);
      const count = buf.readUInt32LE(e + 4);
      t[buf.readUInt16LE(e)] = { type, count, value: type === 3 && count === 1 ? buf.readUInt16LE(e + 8) : buf.readUInt32LE(e + 8) };
    }
    const dpi = (tag) => buf.readUInt32LE(t[tag].value) / buf.readUInt32LE(t[tag].value + 4);
    const strip = t[273].value;
    pages.push({ width: t[256].value, height: t[257].value, dpi: dpi(282), dpiY: dpi(283), compression: t[259].value, samples: t[277].value, pixels: buf.subarray(strip, strip + t[279].value) });
    ifd = buf.readUInt32LE(ifd + 2 + n * 12);
  }
  return pages;
}

// ---- binary property lists (the window and icon view settings are kept in them) --------------------------------------------------------------

class Real {
  constructor(value) {
    this.value = value;
  }
}
/** A number that is written as a real (a floating-point number); a plain JavaScript number is written as an integer. */
export const real = (value) => new Real(value);

const lengthed = (kind, n) => {
  if (n < 15) return Buffer.from([(kind << 4) | n]);
  const size = n < 256 ? Buffer.from([0x10, n]) : Buffer.from([0x11, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([(kind << 4) | 15]), size]);
};

/** A "bplist00" file for strings, booleans, integers, reals, data (Buffer), arrays and dictionaries. */
export function writeBplist(root) {
  const items = [];
  const place = (v) => {
    const index = items.length;
    items.push(null);
    let body;
    if (typeof v === 'boolean') body = Buffer.from([v ? 9 : 8]);
    else if (v instanceof Real) {
      body = Buffer.alloc(9);
      body[0] = 0x23;
      body.writeDoubleBE(v.value, 1);
    } else if (typeof v === 'number') {
      body = v < 256 ? Buffer.from([0x10, v]) : Buffer.from([0x11, v >> 8, v & 255]);
      if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error('only whole numbers up to 65535 are written as integers');
    } else if (typeof v === 'string') {
      body = [...v].every((c) => c.charCodeAt(0) < 128) ? Buffer.concat([lengthed(5, v.length), Buffer.from(v, 'latin1')]) : Buffer.concat([lengthed(6, v.length), Buffer.from(v, 'utf16le').swap16()]);
    } else if (Buffer.isBuffer(v)) body = Buffer.concat([lengthed(4, v.length), v]);
    else if (Array.isArray(v)) body = Buffer.concat([lengthed(10, v.length), Buffer.from(v.map(place))]);
    else {
      const keys = Object.keys(v);
      const k = keys.map((key) => place(key));
      const vals = keys.map((key) => place(v[key]));
      body = Buffer.concat([lengthed(13, keys.length), Buffer.from(k), Buffer.from(vals)]);
    }
    items[index] = body;
    return index;
  };
  place(root);
  if (items.length > 255) throw new Error('too many objects for one-byte references');
  const parts = [Buffer.from('bplist00', 'latin1')];
  const offsets = [];
  let at = 8;
  for (const body of items) {
    offsets.push(at);
    parts.push(body);
    at += body.length;
  }
  const table = Buffer.alloc(offsets.length * 4);
  offsets.forEach((o, i) => table.writeUInt32BE(o, i * 4));
  const trailer = Buffer.alloc(32);
  trailer[6] = 4; // bytes per offset
  trailer[7] = 1; // bytes per object reference
  trailer.writeBigUInt64BE(BigInt(items.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([...parts, table, trailer]);
}

/** The value of a "bplist00" file (numbers of both kinds come back as numbers). */
export function readBplist(buf) {
  if (buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('not a binary property list');
  const t = buf.length - 32;
  const offSize = buf[t + 6];
  const refSize = buf[t + 7];
  const count = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableAt = Number(buf.readBigUInt64BE(t + 24));
  const uint = (at, n) => (n === 1 ? buf[at] : n === 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at));
  const offset = (i) => uint(tableAt + i * offSize, offSize);
  if (top >= count) throw new Error('bad top object');
  const read = (i) => {
    let at = offset(i);
    const marker = buf[at++];
    const kind = marker >> 4;
    let n = marker & 15;
    const size = () => {
      if (n !== 15) return n;
      const m = buf[at++];
      const bytes = 1 << (m & 15);
      const v = uint(at, bytes);
      at += bytes;
      return v;
    };
    if (marker === 8) return false;
    if (marker === 9) return true;
    if (kind === 1) return uint(at, 1 << n);
    if (kind === 2) return n === 3 ? buf.readDoubleBE(at) : buf.readFloatBE(at);
    if (kind === 4) {
      const len = size();
      return buf.subarray(at, at + len);
    }
    if (kind === 5) {
      const len = size();
      return buf.toString('latin1', at, at + len);
    }
    if (kind === 6) {
      const len = size();
      return Buffer.from(buf.subarray(at, at + len * 2)).swap16().toString('utf16le');
    }
    if (kind === 10) {
      const len = size();
      return Array.from({ length: len }, (_, k) => read(uint(at + k * refSize, refSize)));
    }
    if (kind === 13) {
      const len = size();
      const o = {};
      for (let k = 0; k < len; k++) o[read(uint(at + k * refSize, refSize))] = read(uint(at + (len + k) * refSize, refSize));
      return o;
    }
    throw new Error('a kind of object this reader does not know: ' + marker.toString(16));
  };
  return read(top);
}

// ---- the Finder alias of the background picture -----------------------------------------------------------------------------------------

const pad2 = (b) => (b.length & 1 ? Buffer.concat([b, Buffer.alloc(1)]) : b);
const be16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const utf16be = (s) => Buffer.from(s, 'utf16le').swap16();

/**
 * A version 2 alias to a file on a volume, the record the Finder keeps for a background picture. "path" is the folders and the file below the volume's top, "ids" the numbers
 * the file system gave them (all zero when the image has not been made yet: the Finder then finds the file by its path and names, which is what it does for an alias whose numbers
 * no longer match; whether it does on a real screen is not measured here).
 */
export function writeAlias({ volume = VOLUME_NAME, path, ids = {} }) {
  const name = path[path.length - 1];
  const head = Buffer.alloc(150);
  head.writeUInt16BE(2, 6); // version
  head.writeUInt16BE(0, 8); // a file
  head[10] = Buffer.byteLength(volume);
  head.write(volume, 11, 'utf8');
  head.writeUInt32BE(ids.volumeCreated ?? 0, 38);
  head.write('H+', 42, 'latin1');
  head.writeUInt16BE(0, 44); // a fixed disk
  head.writeUInt32BE(ids.parent ?? 0, 46);
  head[50] = Buffer.byteLength(name);
  head.write(name, 51, 'utf8');
  head.writeUInt32BE(ids.file ?? 0, 114);
  head.writeUInt32BE(ids.fileCreated ?? 0, 118);
  head.writeInt16BE(-1, 130);
  head.writeInt16BE(-1, 132);
  const tag = (n, data) => Buffer.concat([be16(n), be16(data.length), pad2(data)]);
  const folder = path.length > 1 ? path[path.length - 2] : volume;
  const hi = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n) * 65536n);
    return b;
  };
  const tags = [
    tag(0, Buffer.from(folder, 'utf8')),
    tag(16, hi(ids.volumeCreated ?? 0)),
    tag(17, hi(ids.fileCreated ?? 0)),
    tag(2, Buffer.from(volume + ':' + path.join(':\0'), 'utf8')),
    tag(14, Buffer.concat([be16(name.length), utf16be(name)])),
    tag(15, Buffer.concat([be16(volume.length), utf16be(volume)])),
    tag(18, Buffer.from('/' + path.join('/'), 'utf8')),
    tag(19, Buffer.from('/Volumes/' + volume, 'utf8')),
    Buffer.from([0xff, 0xff, 0, 0]),
  ];
  const all = Buffer.concat([head, ...tags]);
  all.writeUInt16BE(all.length, 4);
  return all;
}

/** What an alias written by writeAlias holds. */
export function readAlias(buf) {
  const version = buf.readUInt16BE(6);
  if (version !== 2 || buf.readUInt16BE(4) !== buf.length) throw new Error('not a version 2 alias of the length it says');
  const text = (at, max) => buf.toString('utf8', at + 1, at + 1 + Math.min(buf[at], max));
  const a = { version, kind: buf.readUInt16BE(8), volume: text(10, 27), volumeCreated: buf.readUInt32BE(38), fileSystem: buf.toString('latin1', 42, 44), parent: buf.readUInt32BE(46), fileName: text(50, 63), file: buf.readUInt32BE(114), tags: {} };
  for (let at = 150; ; ) {
    const n = buf.readInt16BE(at);
    if (n === -1) break;
    const len = buf.readUInt16BE(at + 2);
    a.tags[n] = buf.subarray(at + 4, at + 4 + len);
    at += 4 + len + (len & 1);
  }
  a.carbonPath = a.tags[2]?.toString('utf8');
  a.posixPath = a.tags[18]?.toString('utf8');
  a.mountPoint = a.tags[19]?.toString('utf8');
  return a;
}

// ---- the .DS_Store file ------------------------------------------------------------------------------------------------------------------

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** One record: file name, a four-letter structure id, a four-letter type, and the value in that type. */
function record(name, id, type, value) {
  const head = Buffer.concat([u32(name.length), utf16be(name), Buffer.from(id, 'latin1'), Buffer.from(type, 'latin1')]);
  if (type === 'bool') return Buffer.concat([head, Buffer.from([value ? 1 : 0])]);
  if (type === 'long') return Buffer.concat([head, u32(value)]);
  if (type === 'blob') return Buffer.concat([head, u32(value.length), value]);
  if (type === 'type') return Buffer.concat([head, Buffer.from(value, 'latin1')]);
  throw new Error('a record type that is not written here: ' + type);
}

const iloc = (x, y) => Buffer.concat([u32(x), u32(y), Buffer.from('ffffffffffff0000', 'hex')]);
const sortKey = (r) => r.name.toLowerCase();

/** The records the Finder reads a window from: the folder's own ("."), then one place for each icon. */
export function layoutRecords(ids = {}) {
  const bounds = '{{' + LAYOUT.x + ', ' + LAYOUT.y + '}, {' + LAYOUT.width + ', ' + (LAYOUT.height + LAYOUT.titleBar) + '}}';
  const window = writeBplist({
    ShowStatusBar: false,
    WindowBounds: bounds,
    ContainerShowSidebar: false,
    PreviewPaneVisibility: false,
    SidebarWidth: 0,
    ShowTabView: false,
    ShowToolbar: false,
    ShowPathbar: false,
    ShowSidebar: false,
  });
  const view = writeBplist({
    viewOptionsVersion: 1,
    backgroundType: 2,
    backgroundColorRed: real(1),
    backgroundColorGreen: real(1),
    backgroundColorBlue: real(1),
    backgroundImageAlias: writeAlias({ path: [BACKGROUND_DIR, BACKGROUND_FILE], ids }),
    gridOffsetX: real(0),
    gridOffsetY: real(0),
    gridSpacing: real(100),
    arrangeBy: 'none',
    showIconPreview: false,
    showItemInfo: false,
    labelOnBottom: true,
    textSize: real(LAYOUT.textSize),
    iconSize: real(LAYOUT.iconSize),
    scrollPositionX: real(0),
    scrollPositionY: real(0),
  });
  const rows = [
    { name: '.', id: 'bwsp', type: 'blob', value: window },
    { name: '.', id: 'icvp', type: 'blob', value: view },
    { name: '.', id: 'vSrn', type: 'long', value: 1 },
    { name: '.', id: 'vstl', type: 'type', value: 'icnv' },
    ...Object.entries(LAYOUT.icons).map(([name, p]) => ({ name, id: 'Iloc', type: 'blob', value: iloc(p.x, p.y) })),
  ];
  return rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : a.id < b.id ? -1 : 1));
}

const NODE_AT = 0x1000;
const ROOT_AT = 0x800;
const DSDB_AT = 0x20;

/** The whole file: the header, the block table with its one name ("DSDB"), the tree's header, and one leaf holding every record. */
export function writeDsStore(ids = {}) {
  const rows = layoutRecords(ids).map((r) => record(r.name, r.id, r.type, r.value));
  const leaf = Buffer.concat([u32(0), u32(rows.length), ...rows]);
  if (leaf.length > 0x1000) throw new Error('the records do not fit one page');
  const file = Buffer.alloc(4 + 0x2000);
  const at = (rel) => 4 + rel;
  file.writeUInt32BE(1, 0);
  file.write('Bud1', 4, 'latin1');
  file.writeUInt32BE(ROOT_AT, 8);
  file.writeUInt32BE(0x800, 12);
  file.writeUInt32BE(ROOT_AT, 16);
  Buffer.from('0000100c0000087c0000000000000000', 'hex').copy(file, 20);
  // the tree's header: its top page, its depth (0: the top page is a leaf), how many records, how many pages, the page size
  Buffer.concat([u32(2), u32(0), u32(rows.length), u32(1), u32(0x1000)]).copy(file, at(DSDB_AT));
  leaf.copy(file, at(NODE_AT));
  // the block table: block 0 is this table, 1 the tree's header, 2 the leaf; an address is the offset with the size's power of two in its low five bits
  const table = [ROOT_AT | 11, DSDB_AT | 5, NODE_AT | 12];
  const root = [u32(table.length), u32(0)];
  for (let i = 0; i < 256; i++) root.push(u32(table[i] ?? 0));
  root.push(u32(1), Buffer.from([4]), Buffer.from('DSDB', 'latin1'), u32(1));
  // free space, for each power of two: what is left in the first 0x2000 bytes, and the blocks beyond the end of the file
  const free = Array.from({ length: 32 }, () => []);
  for (const [k, off] of [[6, 0x40], [7, 0x80], [8, 0x100], [9, 0x200], [10, 0x400]]) free[k].push(off);
  for (let k = 13; k < 32; k++) free[k].push(2 ** k);
  for (const list of free) root.push(u32(list.length), ...list.map(u32));
  Buffer.concat(root).copy(file, at(ROOT_AT));
  return file;
}

/** The records of a .DS_Store file: [{ name, id, type, value }], in the order they are kept. Reads any tree depth. */
export function readDsStore(buf) {
  if (buf.readUInt32BE(0) !== 1 || buf.toString('latin1', 4, 8) !== 'Bud1') throw new Error('not a .DS_Store file');
  const rootAt = buf.readUInt32BE(8);
  if (buf.readUInt32BE(16) !== rootAt) throw new Error('the two copies of the root address differ');
  const base = (addr) => 4 + (addr & ~0x1f);
  const sizeOf = (addr) => 2 ** (addr & 0x1f);
  const r = base(rootAt);
  const count = buf.readUInt32BE(r);
  const blocks = Array.from({ length: count }, (_, i) => buf.readUInt32BE(r + 8 + i * 4));
  let p = r + 8 + Math.ceil(count / 256) * 256 * 4;
  const names = {};
  for (let n = buf.readUInt32BE(p), i = 0, q = p + 4; i < n; i++) {
    const len = buf[q];
    names[buf.toString('latin1', q + 1, q + 1 + len)] = buf.readUInt32BE(q + 1 + len);
    q += 5 + len;
  }
  if (names.DSDB === undefined) throw new Error('no DSDB table');
  const block = (id) => buf.subarray(base(blocks[id]), base(blocks[id]) + sizeOf(blocks[id]));
  const db = block(names.DSDB);
  const out = [];
  const rec = (b, o) => {
    const n = b.readUInt32BE(o);
    const name = Buffer.from(b.subarray(o + 4, o + 4 + n * 2)).swap16().toString('utf16le');
    o += 4 + n * 2;
    const id = b.toString('latin1', o, o + 4);
    const type = b.toString('latin1', o + 4, o + 8);
    o += 8;
    let value;
    if (type === 'bool') value = b[o++] === 1;
    else if (type === 'long' || type === 'shor') {
      value = b.readUInt32BE(o);
      o += 4;
    } else if (type === 'blob') {
      const len = b.readUInt32BE(o);
      value = Buffer.from(b.subarray(o + 4, o + 4 + len));
      o += 4 + len;
    } else if (type === 'type') {
      value = b.toString('latin1', o, o + 4);
      o += 4;
    } else if (type === 'ustr') {
      const len = b.readUInt32BE(o);
      value = Buffer.from(b.subarray(o + 4, o + 4 + len * 2)).swap16().toString('utf16le');
      o += 4 + len * 2;
    } else if (type === 'comp' || type === 'dutc') {
      value = b.readBigUInt64BE(o);
      o += 8;
    } else throw new Error('a record type this reader does not know: ' + type);
    out.push({ name, id, type, value });
    return o;
  };
  const walk = (id) => {
    const b = block(id);
    const right = b.readUInt32BE(0);
    const n = b.readUInt32BE(4);
    let o = 8;
    for (let i = 0; i < n; i++) {
      if (right) {
        walk(b.readUInt32BE(o));
        o += 4;
      }
      o = rec(b, o);
    }
    if (right) walk(right);
  };
  walk(db.readUInt32BE(0));
  if (out.length !== db.readUInt32BE(8)) throw new Error('the tree says ' + db.readUInt32BE(8) + ' records and holds ' + out.length);
  return out;
}

/** What a .DS_Store says about the window, in numbers and words a test can compare. */
export function readLayout(buf) {
  const rows = readDsStore(buf);
  const one = (name, id) => rows.find((r) => r.name === name && r.id === id)?.value;
  const win = readBplist(one('.', 'bwsp'));
  const view = readBplist(one('.', 'icvp'));
  const m = /^\{\{(-?\d+), (-?\d+)\}, \{(\d+), (\d+)\}\}$/.exec(win.WindowBounds);
  if (!m) throw new Error('bad window bounds ' + win.WindowBounds);
  const icons = {};
  for (const r of rows) if (r.id === 'Iloc') icons[r.name] = { x: r.value.readUInt32BE(0), y: r.value.readUInt32BE(4) };
  return {
    window: { x: +m[1], y: +m[2], width: +m[3], height: +m[4] },
    toolbar: win.ShowToolbar,
    sidebar: win.ShowSidebar,
    statusBar: win.ShowStatusBar,
    pathBar: win.ShowPathbar,
    view: one('.', 'vstl'),
    iconSize: view.iconSize,
    textSize: view.textSize,
    labelOnBottom: view.labelOnBottom,
    arrangeBy: view.arrangeBy,
    backgroundType: view.backgroundType,
    background: readAlias(view.backgroundImageAlias),
    icons,
  };
}

// ---- the folder hdiutil packs, and the check of one ---------------------------------------------------------------------------------------

/** The disk image's folder: the app, the link to Applications, the hidden background folder with its picture, and the .DS_Store. */
export function buildDmgFolder({ app, folder, ids }) {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(join(folder, BACKGROUND_DIR), { recursive: true });
  cpSync(app, join(folder, APP_NAME), { recursive: true, verbatimSymlinks: true });
  symlinkSync('/Applications', join(folder, 'Applications'));
  writeFileSync(join(folder, BACKGROUND_DIR, BACKGROUND_FILE), backgroundTiff());
  writeFileSync(join(folder, '.DS_Store'), writeDsStore(ids));
  return folder;
}

/**
 * Everything a person needs to see in the window, read from a folder or a mounted image: the app, the Applications link and where it points, the background pictures, and the layout the
 * .DS_Store holds (window size, one row of two icons with the app on the left, icon size, the background it names). Returns the list of what is wrong; empty when all is right.
 */
export function checkDmgFolder(folder) {
  const bad = [];
  const need = (ok, what) => {
    if (!ok) bad.push(what);
    return ok;
  };
  if (need(existsSync(join(folder, APP_NAME, 'Contents', 'Info.plist')), 'the app ' + APP_NAME + ' is missing')) need(lstatSync(join(folder, APP_NAME)).isDirectory(), APP_NAME + ' is not a folder');
  const link = join(folder, 'Applications');
  if (need(existsSync(link) || lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink(), 'the Applications link is missing')) {
    need(lstatSync(link).isSymbolicLink(), 'Applications is not a link');
    need(lstatSync(link).isSymbolicLink() && readlinkSync(link) === '/Applications', 'the Applications link does not point to /Applications');
  }
  const picture = join(folder, BACKGROUND_DIR, BACKGROUND_FILE);
  if (need(existsSync(picture), 'the background picture is missing')) {
    try {
      const pages = readTiff(readFileSync(picture));
      need(pages.length === 2, 'the background holds ' + pages.length + ' pictures, not the 1x and the @2x');
      pages.forEach((p, i) => need(p.width === LAYOUT.width * (i + 1) && p.height === LAYOUT.height * (i + 1) && p.dpi === 72 * (i + 1), 'background picture ' + (i + 1) + ' is ' + p.width + 'x' + p.height + ' at ' + p.dpi + ' dpi'));
    } catch (e) {
      bad.push('the background is not a readable picture: ' + e.message);
    }
  }
  const store = join(folder, '.DS_Store');
  if (!need(existsSync(store), 'the .DS_Store is missing')) return bad;
  let l;
  try {
    l = readLayout(readFileSync(store));
  } catch (e) {
    bad.push('the .DS_Store cannot be read: ' + e.message);
    return bad;
  }
  need(l.window.width === LAYOUT.width && l.window.height === LAYOUT.height + LAYOUT.titleBar, 'the window is ' + l.window.width + 'x' + l.window.height);
  need(!l.toolbar && !l.sidebar && !l.statusBar && !l.pathBar, 'the window shows a toolbar, sidebar, status bar or path bar');
  need(l.view === 'icnv' && l.arrangeBy === 'none', 'the window is not a plain icon view');
  need(l.iconSize === LAYOUT.iconSize && l.textSize === LAYOUT.textSize, 'icon size ' + l.iconSize + ', text size ' + l.textSize);
  const a = l.icons[APP_NAME];
  const b = l.icons.Applications;
  if (need(a && b, 'an icon has no place')) {
    need(a.y === b.y && a.x < b.x, 'the app is not on the left of Applications in one row');
    need(a.x === LAYOUT.icons[APP_NAME].x && b.x === LAYOUT.icons.Applications.x && a.y === LAYOUT.icons[APP_NAME].y, 'the icons are not where the picture draws them');
  }
  need(l.backgroundType === 2, 'the background is not a picture');
  need(l.background.posixPath === '/' + BACKGROUND_DIR + '/' + BACKGROUND_FILE && l.background.fileName === BACKGROUND_FILE && l.background.volume === VOLUME_NAME, 'the background names ' + l.background.posixPath + ' on ' + l.background.volume);
  need(readdirSync(join(folder, BACKGROUND_DIR)).join() === BACKGROUND_FILE, 'the background folder holds more than the picture');
  return bad;
}
