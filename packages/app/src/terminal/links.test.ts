import { describe, expect, it } from "vitest";

import { findPaths } from "./links";

const only = (line: string) =>
  findPaths(line).map(({ path, line: l, column }) => ({ path, l, column }));

describe("N-02 file links", () => {
  it("finds absolute Windows paths with positions", () => {
    expect(only(String.raw`error at C:\src\app\main.ts:12:5 here`)).toEqual([
      { path: String.raw`C:\src\app\main.ts`, l: 12, column: 5 },
    ]);
    expect(only("see C:/src/app/README.md.")).toEqual([
      { path: "C:/src/app/README.md", l: undefined, column: undefined },
    ]);
  });

  it("finds absolute macOS and Linux paths", () => {
    expect(only("panic at /home/me/src/main.rs:40:9")).toEqual([
      { path: "/home/me/src/main.rs", l: 40, column: 9 },
    ]);
    expect(only("wrote /Users/me/notes.md.")).toEqual([
      { path: "/Users/me/notes.md", l: undefined, column: undefined },
    ]);
  });

  it("finds relative paths, TypeScript/MSBuild and bare file:line forms", () => {
    expect(only("src/layout/tree.ts:42 - error TS2345")).toEqual([
      { path: "src/layout/tree.ts", l: 42, column: undefined },
    ]);
    expect(only(String.raw`Program.cs(17,9): warning CS0168`)).toEqual([
      { path: "Program.cs", l: 17, column: 9 },
    ]);
    expect(only(String.raw`..\lib\util.rs:3:1`)).toEqual([
      { path: String.raw`..\lib\util.rs`, l: 3, column: 1 },
    ]);
    expect(only("  at foo (./node_modules/x/index.js:10:20)")).toEqual([
      { path: "./node_modules/x/index.js", l: 10, column: 20 },
    ]);
  });

  it("leaves URLs, plain words and versions alone", () => {
    expect(findPaths("open https://example.com/docs/page.html now")).toEqual([]);
    expect(findPaths("version 1.2.3 is out, see notes.")).toEqual([]);
    expect(findPaths("just words here")).toEqual([]);
  });

  it("reports where the match starts, for underlining", () => {
    const [match] = findPaths("x src/a.ts:1:2");
    expect(match?.start).toBe(2);
    expect(match?.text).toBe("src/a.ts:1:2");
  });
});
