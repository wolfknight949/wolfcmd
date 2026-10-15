import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { brotliDecompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import manifest from "./fonts/wolfcmd-icons.json";
import { GLYPHS } from "./glyphs";

describe("calm chrome glyphs", () => {
  it("has no lightning glyph (E945) under any name", () => {
    expect(Object.values(GLYPHS)).not.toContain("\u{E945}");
    expect(Object.keys(GLYPHS)).not.toContain("sparkle");
  });

  it("'open in another app' is a window with an arrow, not the `{}` code glyph", () => {
    expect(GLYPHS.openExternal).toBe("\u{E8A7}");
    expect(GLYPHS.openExternal).not.toBe(GLYPHS.code);
  });
});

/** A file of the lucide-static package (the repository root's devDependency the font is built
 *  from, `pnpm icons`). */
function lucideFile(...parts: string[]): string {
  const root = join(import.meta.dirname, "..", "..", "..");
  const pkg = createRequire(join(root, "package.json")).resolve("lucide-static/package.json");
  return join(dirname(pkg), ...parts);
}

/** "E710" for "\u{E710}". */
const hex = (glyph: string) => (glyph.codePointAt(0) ?? 0).toString(16).toUpperCase();

/** The code points of the bundled WOFF2 (written by tools/icon-font.mjs: untransformed tables). */
function fontCodePoints(): Set<number> {
  const path = join(import.meta.dirname, "fonts", "wolfcmd-icons.woff2");
  const file = readFileSync(path);
  expect(file.toString("latin1", 0, 4)).toBe("wOF2");
  // Table directory: flags (known tag index in bits 0-5), then the length as UIntBase128.
  let at = 48;
  let offset = 0;
  let cmap: { offset: number; length: number } | undefined;
  for (let i = 0; i < file.readUInt16BE(12); i++) {
    const tag = (file[at++] ?? 0) & 0x3f;
    let length = 0;
    let byte = 0x80;
    while (byte & 0x80) {
      byte = file[at++] ?? 0;
      length = length * 128 + (byte & 0x7f);
    }
    if (tag === 0) cmap = { offset, length };
    offset += length;
  }
  if (!cmap) throw new Error("no cmap table");
  const data = brotliDecompressSync(file.subarray(at, at + file.readUInt32BE(20)));
  const table = data.subarray(cmap.offset, cmap.offset + cmap.length);
  // One format 4 subtable; every segment maps a run directly (idRangeOffset 0).
  const sub = table.readUInt32BE(8);
  expect(table.readUInt16BE(sub)).toBe(4);
  const segments = table.readUInt16BE(sub + 6) / 2;
  const codes = new Set<number>();
  for (let s = 0; s < segments; s++) {
    const end = table.readUInt16BE(sub + 14 + 2 * s);
    const start = table.readUInt16BE(sub + 16 + 2 * segments + 2 * s);
    for (let code = start; code <= end && code !== 0xffff; code++) codes.add(code);
  }
  return codes;
}

describe("bundled icon font", () => {
  const glyphs: Readonly<Record<string, string>> = manifest.glyphs;

  it("every GLYPHS code point is in the WolfCmd Icons manifest", () => {
    const missing = Object.entries(GLYPHS).filter(([, glyph]) => !(hex(glyph) in glyphs));
    expect(missing).toEqual([]);
  });

  it("the manifest has no glyph GLYPHS doesn't use", () => {
    const used = new Set(Object.values(GLYPHS).map(hex));
    expect(Object.keys(glyphs).filter((code) => !used.has(code))).toEqual([]);
  });

  it("N-01: every glyph is a Lucide icon, named as in lucide-static", () => {
    expect(manifest.source).toMatch(/^lucide-static /);
    const known = JSON.parse(readFileSync(lucideFile("font", "codepoints.json"), "utf8")) as Record<
      string,
      number
    >;
    expect(Object.values(glyphs).filter((name) => !(name in known))).toEqual([]);
  });

  it("N-01: the font ships with Lucide's license", () => {
    const license = readFileSync(join(import.meta.dirname, "fonts", "LICENSE"), "utf8");
    expect(license).toContain("ISC License");
    expect(license).toContain("Lucide Icons and Contributors");
  });

  it("the bundled WOFF2 maps exactly the manifest's code points", () => {
    const expected = Object.keys(glyphs)
      .map((code) => parseInt(code, 16))
      .sort((a, b) => a - b);
    expect([...fontCodePoints()].sort((a, b) => a - b)).toEqual(expected);
  });

  it("the code points stay in the Basic Multilingual Plane's private use area", () => {
    for (const glyph of Object.values(GLYPHS)) {
      expect(glyph).toHaveLength(1);
      expect(glyph.codePointAt(0)).toBeGreaterThanOrEqual(0xe000);
      expect(glyph.codePointAt(0)).toBeLessThanOrEqual(0xf8ff);
    }
  });
});
