// N-01: builds WolfCmd Icons (packages/ui-kit/src/fonts/wolfcmd-icons.woff2), the icon font the
// app ships: the Lucide icons (ISC, from the lucide-static devDependency) that
// `wolfcmd-icons.json` names, each at WolfCmd's own private-use code point. Simple line icons on
// every OS (the calm and warm look, packages/ui-kit/CLAUDE.md).
//
//   pnpm icons        (after editing `glyphs` in the manifest)
//
// A small TrueType subsetter and WOFF2 writer with no other dependency: simple glyphs copied as
// they are, one glyph per code point, a format 4 cmap, long loca, and untransformed WOFF2 tables
// in one Brotli stream (packages/ui-kit/src/glyphs.test.ts reads it back).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const root = join(import.meta.dirname, "..");
const fonts = join(root, "packages", "ui-kit", "src", "fonts");
const require = createRequire(join(root, "package.json"));
const lucide = join(require.resolve("lucide-static/package.json"), "..");

const manifestPath = join(fonts, "wolfcmd-icons.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = JSON.parse(readFileSync(join(lucide, "package.json"), "utf8")).version;
/** Lucide icon name → its code point in lucide.ttf. */
const names = new Map(
  Object.entries(JSON.parse(readFileSync(join(lucide, "font", "codepoints.json"), "utf8"))),
);

const source = readFileSync(join(lucide, "font", "lucide.ttf"));

/** The source font's tables by tag. */
const tables = new Map();
for (let i = 0; i < source.readUInt16BE(4); i++) {
  const at = 12 + 16 * i;
  const tag = source.toString("latin1", at, at + 4);
  const offset = source.readUInt32BE(at + 8);
  tables.set(tag, source.subarray(offset, offset + source.readUInt32BE(at + 12)));
}
const table = (tag) => {
  const data = tables.get(tag);
  if (data === undefined) throw new Error(`lucide.ttf has no ${tag} table`);
  return data;
};

/** The source glyph ID of a code point (the Windows Unicode format 4 cmap). */
function glyphOf(code) {
  const cmap = table("cmap");
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const record = 4 + 8 * i;
    if (cmap.readUInt16BE(record) !== 3 || cmap.readUInt16BE(record + 2) !== 1) continue;
    const sub = cmap.readUInt32BE(record + 4);
    const segments = cmap.readUInt16BE(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + 2 * segments + 2;
    const deltas = starts + 2 * segments;
    const ranges = deltas + 2 * segments;
    for (let s = 0; s < segments; s++) {
      if (code > cmap.readUInt16BE(ends + 2 * s)) continue;
      if (code < cmap.readUInt16BE(starts + 2 * s)) return 0;
      const delta = cmap.readInt16BE(deltas + 2 * s);
      const range = cmap.readUInt16BE(ranges + 2 * s);
      if (range === 0) return (code + delta) & 0xffff;
      const at = ranges + 2 * s + range + 2 * (code - cmap.readUInt16BE(starts + 2 * s));
      const glyph = cmap.readUInt16BE(at);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
  }
  return 0;
}

const head = table("head");
const longLoca = head.readInt16BE(50) === 1;
const loca = table("loca");
const glyf = table("glyf");
const hhea = table("hhea");
const hmtx = table("hmtx");
const longMetrics = hhea.readUInt16BE(34);

/** A source glyph's outline (empty for a blank glyph). */
function outline(id) {
  const [from, to] = longLoca
    ? [loca.readUInt32BE(4 * id), loca.readUInt32BE(4 * id + 4)]
    : [2 * loca.readUInt16BE(2 * id), 2 * loca.readUInt16BE(2 * id + 2)];
  const data = glyf.subarray(from, to);
  if (data.length > 0 && data.readInt16BE(0) < 0) {
    throw new Error(`glyph ${String(id)} is a composite glyph (not supported)`);
  }
  return data;
}

/** A source glyph's advance width and left side bearing. */
function metrics(id) {
  const last = longMetrics - 1;
  const advance = hmtx.readUInt16BE(4 * Math.min(id, last));
  const lsb =
    id < longMetrics
      ? hmtx.readInt16BE(4 * id + 2)
      : hmtx.readInt16BE(4 * longMetrics + 2 * (id - longMetrics));
  return { advance, lsb };
}

// The new font's glyphs: .notdef, then one per WolfCmd code point in ascending order.
const entries = Object.entries(manifest.glyphs)
  .map(([code, name]) => {
    const from = names.get(name);
    if (from === undefined) throw new Error(`no Lucide icon named "${name}" (${code})`);
    const id = glyphOf(from);
    if (id === 0) throw new Error(`lucide.ttf has no glyph for "${name}"`);
    return { code: parseInt(code, 16), id };
  })
  .sort((a, b) => a.code - b.code);
const glyphs = [0, ...entries.map((entry) => entry.id)];

const pad4 = (buffer) =>
  buffer.length % 4 === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]);

// glyf, loca (long) and hmtx.
const outlines = glyphs.map((id) => pad4(outline(id)));
const newLoca = Buffer.alloc(4 * (glyphs.length + 1));
let offset = 0;
outlines.forEach((data, i) => {
  newLoca.writeUInt32BE(offset, 4 * i);
  offset += data.length;
});
newLoca.writeUInt32BE(offset, 4 * glyphs.length);
const newGlyf = Buffer.concat(outlines);
const newHmtx = Buffer.alloc(4 * glyphs.length);
glyphs.forEach((id, i) => {
  const { advance, lsb } = metrics(id);
  newHmtx.writeUInt16BE(advance, 4 * i);
  newHmtx.writeInt16BE(lsb, 4 * i + 2);
});

// cmap: (3, 1) format 4, one segment per run of consecutive code points (idDelta only).
const runs = [];
entries.forEach((entry, i) => {
  const run = runs.at(-1);
  if (run !== undefined && entry.code === run.end + 1) run.end = entry.code;
  else runs.push({ start: entry.code, end: entry.code, glyph: i + 1 });
});
runs.push({ start: 0xffff, end: 0xffff, glyph: 1 });
const segments = runs.length;
const format4 = Buffer.alloc(16 + 8 * segments);
format4.writeUInt16BE(4, 0);
format4.writeUInt16BE(format4.length, 2);
format4.writeUInt16BE(2 * segments, 6);
const power = 2 ** Math.floor(Math.log2(segments));
format4.writeUInt16BE(2 * power, 8);
format4.writeUInt16BE(Math.log2(power), 10);
format4.writeUInt16BE(2 * segments - 2 * power, 12);
runs.forEach((run, s) => {
  format4.writeUInt16BE(run.end, 14 + 2 * s);
  format4.writeUInt16BE(run.start, 16 + 2 * segments + 2 * s);
  format4.writeUInt16BE((run.glyph - run.start) & 0xffff, 16 + 4 * segments + 2 * s);
  // idRangeOffset stays 0.
});
const cmapHeader = Buffer.alloc(12);
cmapHeader.writeUInt16BE(1, 2);
cmapHeader.writeUInt16BE(3, 4);
cmapHeader.writeUInt16BE(1, 6);
cmapHeader.writeUInt32BE(12, 8);
const newCmap = Buffer.concat([cmapHeader, format4]);

// head (long loca), hhea, maxp, OS/2 (first and last character), post (no glyph names).
const newHead = Buffer.from(head);
newHead.writeUInt32BE(0, 8);
newHead.writeInt16BE(1, 50);
const newHhea = Buffer.from(hhea);
newHhea.writeUInt16BE(glyphs.length, 34);
const newMaxp = Buffer.from(table("maxp"));
newMaxp.writeUInt16BE(glyphs.length, 4);
const os2 = Buffer.from(table("OS/2"));
os2.writeUInt16BE(entries[0].code, 64);
os2.writeUInt16BE(entries.at(-1).code, 66);
const post = Buffer.from(table("post").subarray(0, 32));
post.writeUInt32BE(0x00030000, 0);

// name: WolfCmd Icons, with the attribution the license asks for.
const strings = [
  [
    0,
    `Lucide icons, ISC License, Copyright (c) Lucide Icons and Contributors (lucide-static ${version})`,
  ],
  [1, "WolfCmd Icons"],
  [2, "Regular"],
  [3, `WolfCmd Icons ${version}`],
  [4, "WolfCmd Icons"],
  [5, `Version ${version}`],
  [6, "WolfCmdIcons"],
];
const encoded = strings.map(([, text]) => Buffer.from(text, "utf16le").swap16());
const nameHeader = Buffer.alloc(6 + 12 * strings.length);
nameHeader.writeUInt16BE(strings.length, 2);
nameHeader.writeUInt16BE(nameHeader.length, 4);
let stringAt = 0;
strings.forEach(([id], i) => {
  const record = 6 + 12 * i;
  nameHeader.writeUInt16BE(3, record);
  nameHeader.writeUInt16BE(1, record + 2);
  nameHeader.writeUInt16BE(0x409, record + 4);
  nameHeader.writeUInt16BE(id, record + 6);
  nameHeader.writeUInt16BE(encoded[i].length, record + 8);
  nameHeader.writeUInt16BE(stringAt, record + 10);
  stringAt += encoded[i].length;
});
const newName = Buffer.concat([nameHeader, ...encoded]);

const out = new Map([
  ["OS/2", os2],
  ["cmap", newCmap],
  ["glyf", newGlyf],
  ["head", newHead],
  ["hhea", newHhea],
  ["hmtx", newHmtx],
  ["loca", newLoca],
  ["maxp", newMaxp],
  ["name", newName],
  ["post", post],
]);

const checksum = (data) => {
  const padded = pad4(data);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
};

// head.checkSumAdjustment over the whole sfnt (tags in ascending order, as an sfnt has them).
const sorted = [...out.keys()].sort();
const sfntSize = 12 + 16 * sorted.length + sorted.reduce((n, t) => n + pad4(out.get(t)).length, 0);
{
  const directory = Buffer.alloc(12 + 16 * sorted.length);
  directory.writeUInt32BE(0x00010000, 0);
  directory.writeUInt16BE(sorted.length, 4);
  const power2 = 2 ** Math.floor(Math.log2(sorted.length));
  directory.writeUInt16BE(16 * power2, 6);
  directory.writeUInt16BE(Math.log2(power2), 8);
  directory.writeUInt16BE(16 * sorted.length - 16 * power2, 10);
  let at = directory.length;
  sorted.forEach((tag, i) => {
    const data = out.get(tag);
    const record = 12 + 16 * i;
    directory.write(tag, record, "latin1");
    directory.writeUInt32BE(checksum(data), record + 4);
    directory.writeUInt32BE(at, record + 8);
    directory.writeUInt32BE(data.length, record + 12);
    at += pad4(data).length;
  });
  const whole = Buffer.concat([directory, ...sorted.map((tag) => pad4(out.get(tag)))]);
  newHead.writeUInt32BE((0xb1b0afba - checksum(whole)) >>> 0, 8);
}

// WOFF2: glyf then loca (both with the null transform), the others in tag order.
const KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm"];
KNOWN.push("glyf", "loca");
const order = sorted.filter((tag) => tag !== "loca");
order.splice(order.indexOf("glyf") + 1, 0, "loca");
const base128 = (value) => {
  const bytes = [value & 0x7f];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift(0x80 | (rest & 0x7f));
  return Buffer.from(bytes);
};
const directory = Buffer.concat(
  order.map((tag) => {
    const known = KNOWN.indexOf(tag);
    if (known < 0) throw new Error(`no WOFF2 tag index for ${tag}`);
    // glyf and loca: transform version 3 is the null transform.
    const transform = tag === "glyf" || tag === "loca" ? 3 << 6 : 0;
    return Buffer.concat([Buffer.from([known | transform]), base128(out.get(tag).length)]);
  }),
);
const compressed = brotliCompressSync(Buffer.concat(order.map((tag) => out.get(tag))), {
  params: {
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
    [constants.BROTLI_PARAM_QUALITY]: 11,
  },
});
const header = Buffer.alloc(48);
const body = pad4(Buffer.concat([directory, compressed]));
header.write("wOF2", 0, "latin1");
header.writeUInt32BE(0x00010000, 4);
header.writeUInt32BE(header.length + body.length, 8);
header.writeUInt16BE(order.length, 12);
header.writeUInt32BE(sfntSize, 16);
header.writeUInt32BE(compressed.length, 20);
header.writeUInt16BE(1, 24);
const woff2 = Buffer.concat([header, body]);
writeFileSync(join(fonts, "wolfcmd-icons.woff2"), woff2);
console.log(
  `wolfcmd-icons.woff2: ${String(entries.length)} glyphs, ${String(woff2.length)} bytes (lucide-static ${version})`,
);
