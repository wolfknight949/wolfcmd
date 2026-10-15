// N-02: the terminal's find bar, floating at the top right. Enter finds the next match,
// Shift+Enter the previous, Esc closes; Aa and .* toggle case and regex.
import { Button, IconButton, isImeKey, useExitMotion } from "@wolfcmd/ui-kit";
import { useRef, useState } from "react";

import type { FindOptions } from "../terminal/terminal-view";

export interface FindBarProps {
  /** The active match (0-based, -1 for none) and how many there are. */
  readonly results: { readonly index: number; readonly count: number };
  readonly onFind: (query: string, options: FindOptions, backwards: boolean) => void;
  readonly onClose: () => void;
  /** Searching one command's output (its short command line); absent: everything. */
  readonly scope?: string | undefined;
}

/** "3 of 12", "No results", or nothing before anything was typed. */
export function matchCount(query: string, index: number, count: number): string {
  if (count === 0) return query === "" ? "" : "No results";
  return `${String(index + 1)} of ${String(count)}`;
}

export function FindBar({ results, onFind, onClose, scope }: FindBarProps) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FindOptions>({ caseSensitive: false, regex: false });
  // N-01: it drifts in and, closing, fades out where it was.
  const bar = useRef<HTMLDivElement>(null);
  useExitMotion(bar);

  const run = (next: { query?: string; options?: FindOptions; backwards?: boolean }) => {
    onFind(next.query ?? query, next.options ?? options, next.backwards ?? false);
  };
  const flip = (key: keyof FindOptions) => {
    const next = { ...options, [key]: !options[key] };
    setOptions(next);
    run({ options: next });
  };

  return (
    <div
      ref={bar}
      role="search"
      className="absolute top-2 right-5 z-10 flex max-w-(--wc-findbar-max-w) items-center gap-1 wc-surface-flyout p-1.5 wc-flyout-in"
    >
      {scope !== undefined && (
        // Which output is searched (Ctrl+Shift+F searches everything again).
        <span className="max-w-40 min-w-0 shrink truncate px-1 text-xs text-fg-muted" title={scope}>
          In the output of {scope}
        </span>
      )}
      <input
        // Focusing the field the moment it opens is what the user asked for.
        autoFocus
        value={query}
        aria-label="Find in terminal"
        placeholder={scope === undefined ? "Find" : "Find in this output"}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          run({ query: e.target.value });
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (isImeKey(e.nativeEvent)) return;
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") run({ backwards: e.shiftKey });
        }}
        className="wc-input h-(--wc-control-h-sm) min-h-0 w-48 min-w-0 shrink py-0"
      />
      <span className="min-w-14 px-1 text-center text-sm text-fg-muted tabular-nums">
        {matchCount(query, results.index, results.count)}
      </span>
      <Button
        variant="subtle"
        size="sm"
        pressed={options.caseSensitive}
        title="Match case"
        aria-label="Match case"
        onClick={() => {
          flip("caseSensitive");
        }}
      >
        Aa
      </Button>
      <Button
        variant="subtle"
        size="sm"
        pressed={options.regex}
        title="Use regular expression"
        aria-label="Use regular expression"
        onClick={() => {
          flip("regex");
        }}
      >
        .*
      </Button>
      <IconButton
        icon="chevronUp"
        label="Previous match (Shift+Enter)"
        onClick={() => {
          run({ backwards: true });
        }}
      />
      <IconButton
        icon="chevronDown"
        label="Next match (Enter)"
        onClick={() => {
          run({});
        }}
      />
      <IconButton icon="close" label="Close (Esc)" onClick={onClose} />
    </div>
  );
}
