// N-02: "Find in this output": the find bar searches only one command's output. The search
// addon has no range, so the view reads that output's rows once per query and searches them
// here (pure, tested); the active match is selected and the others are highlighted.
import type { BufferRow } from "./marks";

/** The most matches highlighted in one output (more are still counted and reachable). */
export const MAX_SCOPED_HIGHLIGHTS = 200;
/** The most matches counted in one output. */
const MAX_SCOPED_MATCHES = 5_000;

/** A match: its first buffer row and column, and its length in characters. */
export interface ScopedMatch {
  readonly row: number;
  readonly col: number;
  readonly length: number;
}

/** The query as a global regular expression; `undefined` for an empty or invalid one. */
export function queryPattern(
  query: string,
  options: { readonly caseSensitive: boolean; readonly regex: boolean },
): RegExp | undefined {
  if (query === "") return undefined;
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch {
    return undefined;
  }
}

/**
 * Every match of `query` in `rows` (the buffer rows from `firstRow` on). A wrapped row
 * continues the line above, so a match can cross the row boundary; it is reported at the row
 * and column it starts at (wide characters can shift the column a little).
 */
export function findInRows(
  rows: readonly BufferRow[],
  firstRow: number,
  query: string,
  options: { readonly caseSensitive: boolean; readonly regex: boolean },
  limit = MAX_SCOPED_MATCHES,
): ScopedMatch[] {
  const pattern = queryPattern(query, options);
  if (pattern === undefined) return [];
  const matches: ScopedMatch[] = [];
  // Logical lines: their text and where each of their rows starts in it.
  let index = 0;
  while (index < rows.length && matches.length < limit) {
    const starts: number[] = [];
    let text = "";
    const lineRow = firstRow + index;
    do {
      starts.push(text.length);
      text += rows[index]?.text ?? "";
      index += 1;
    } while (index < rows.length && rows[index]?.wrapped === true);
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
      if (found[0].length === 0) {
        pattern.lastIndex += 1; // an empty match (`^`, `a*`) never moves on by itself
        continue;
      }
      let part = 0;
      while (part + 1 < starts.length && (starts[part + 1] ?? Infinity) <= found.index) part += 1;
      matches.push({
        row: lineRow + part,
        col: found.index - (starts[part] ?? 0),
        length: found[0].length,
      });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

/** The match to go to next from `current` (-1: none yet), wrapping around. */
export function nextMatch(current: number, count: number, backwards: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}
