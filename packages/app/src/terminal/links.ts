// N-02: file paths in terminal output (compiler errors, stack traces, agent messages), with an
// optional `:line:col` or `(line,col)`, Ctrl+clicked to open (the core decides how,
// crates/wcmd-app/src/open.rs). URLs are xterm's web-links addon's; OSC 8 links are xterm's.

export interface PathMatch {
  /** Index of the first character in the line. */
  readonly start: number;
  /** The whole matched text (what gets underlined). */
  readonly text: string;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

const POSITION = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?`;
/**
 * `C:\dir\file.ext` / `C:/dir/file.ext`, `/home/me/file.ext`, or relative `dir/file.ext`,
 * `./x.ts`, `..\x.cs`, or a bare `file.ext` followed by a position.
 */
const PATH = [
  String.raw`[A-Za-z]:[\\/](?:[^\s"'<>|*?:()\[\]]+[\\/])*[^\s"'<>|*?:()\[\]]+`,
  String.raw`/(?:[\w@.+-]+/)+[\w@.+-]+\.[A-Za-z0-9]+`,
  String.raw`(?:\.{1,2}[\\/])?(?:[\w@.+-]+[\\/])+[\w@.+-]+\.[A-Za-z0-9]+`,
  String.raw`[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,9}(?=:\d|\(\d)`,
].join("|");
const PATTERN = new RegExp(`(${PATH})${POSITION}`, "g");

/** Trailing punctuation that ends a sentence, not a path. */
const TRAILING = /[.,;]+$/;

export function findPaths(line: string): PathMatch[] {
  const matches: PathMatch[] = [];
  for (const m of line.matchAll(PATTERN)) {
    const [whole, rawPath = "", l1, c1, l2, c2] = m;
    const start = m.index;
    // Part of a URL (`https://host/a/b.js`): the web-links addon owns it.
    if (/[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(line.slice(0, start))) continue;
    if (start > 0 && /[\w/\\]/.test(line[start - 1] ?? "")) continue;
    const hasPosition = l1 !== undefined || l2 !== undefined;
    const path = hasPosition ? rawPath : rawPath.replace(TRAILING, "");
    const text = hasPosition ? whole : path;
    const lineNumber = Number(l1 ?? l2);
    const columnNumber = Number(c1 ?? c2);
    matches.push({
      start,
      text,
      path,
      ...(Number.isFinite(lineNumber) ? { line: lineNumber } : {}),
      ...(Number.isFinite(columnNumber) ? { column: columnNumber } : {}),
    });
  }
  return matches;
}
