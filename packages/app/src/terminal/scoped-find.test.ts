import { describe, expect, it } from "vitest";

import { findInRows, nextMatch, queryPattern } from "./scoped-find";

const row = (text: string, wrapped = false) => ({ text, wrapped });
const plain = { caseSensitive: false, regex: false };

describe("N-02 find in one command's output", () => {
  it("n02_find_scoped: matches with their buffer row and column", () => {
    const rows = [row("ok  build"), row("FAIL test a"), row("fail test b")];
    expect(findInRows(rows, 40, "fail", plain)).toEqual([
      { row: 41, col: 0, length: 4 },
      { row: 42, col: 0, length: 4 },
    ]);
  });

  it("n02_find_scoped: match case and regular expressions", () => {
    const rows = [row("FAIL a"), row("fail b")];
    expect(findInRows(rows, 0, "fail", { caseSensitive: true, regex: false })).toEqual([
      { row: 1, col: 0, length: 4 },
    ]);
    expect(findInRows(rows, 0, "f\\w+ [ab]", { caseSensitive: false, regex: true })).toHaveLength(
      2,
    );
    // An invalid expression finds nothing (the find bar shows "No results").
    expect(findInRows(rows, 0, "(", { caseSensitive: false, regex: true })).toEqual([]);
    expect(findInRows(rows, 0, "", plain)).toEqual([]);
    // Special characters are literal without regex.
    expect(findInRows([row("a.b axb")], 0, "a.b", plain)).toEqual([{ row: 0, col: 0, length: 3 }]);
  });

  it("n02_find_scoped: a wrapped row continues the line above (a match can cross it)", () => {
    const rows = [row("error: som"), row("ething broke", true), row("next")];
    expect(findInRows(rows, 10, "something", plain)).toEqual([{ row: 10, col: 7, length: 9 }]);
    expect(findInRows(rows, 10, "broke", plain)).toEqual([{ row: 11, col: 7, length: 5 }]);
  });

  it("n02_find_scoped: empty regex matches never loop", () => {
    expect(findInRows([row("abc")], 0, "x*", { caseSensitive: false, regex: true })).toEqual([]);
  });

  it("n02_find_scoped: counts stop at the limit", () => {
    const rows = Array.from({ length: 10 }, () => row("a a a"));
    expect(findInRows(rows, 0, "a", plain, 7)).toHaveLength(7);
  });

  it("n02_find_scoped: Enter and Shift+Enter wrap around", () => {
    expect(nextMatch(-1, 3, false)).toBe(0);
    expect(nextMatch(-1, 3, true)).toBe(2);
    expect(nextMatch(2, 3, false)).toBe(0);
    expect(nextMatch(0, 3, true)).toBe(2);
    expect(nextMatch(0, 0, false)).toBe(-1);
  });

  it("n02_find_scoped: the pattern is global and case-insensitive unless asked", () => {
    expect(queryPattern("a", plain)?.flags).toBe("gi");
    expect(queryPattern("a", { caseSensitive: true, regex: false })?.flags).toBe("g");
  });
});
