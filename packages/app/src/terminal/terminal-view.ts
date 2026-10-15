// N-02: one terminal: xterm.js connected to a shell in the core. Lives outside React on purpose:
// output is written straight from the IPC channel into xterm, never through component state.
// It also holds the terminal's features: find, links, command marks (gutter dots,
// prompt jumps, the sticky header, per-command actions), the paste guard, image paste into
// agents, OSC 9/777 attention and OSC 9;4 progress, the Kitty keyboard protocol (a setting),
// IME, Shift+Enter, right-click copy/paste or N-03 the terminal's menu, and WebGL with the DOM
// renderer as fallback.
import "@xterm/xterm/css/xterm.css";

import {
  chordLetter,
  isApple,
  isImeKey,
  isKeyboardMenu,
  isWindows,
  primaryModifier,
} from "@wolfcmd/ui-kit";
import { FitAddon } from "@xterm/addon-fit";
import { type ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type IDecoration, type ILink, type IMarker, type ITheme, Terminal } from "@xterm/xterm";

import { clipboardText, openLink } from "../core/app";
import { openTerminal, type TerminalSession } from "../core/terminal";
import type { TerminalProgress } from "../store/attention";
import type { FullSettings } from "../store/settings";
import { editKey, rightClickAction } from "./context-menu";
import { debounce } from "./debounce";
import { createGpu } from "./gpu";
import { chordBytes, hasImage } from "./image-paste";
import {
  csiParam,
  encodeKittyKey,
  type KittyStack,
  kittyFlags,
  kittyPop,
  kittyPush,
  kittyQueryReply,
  kittySet,
} from "./kitty";
import { findPaths } from "./links";
import {
  blockRange,
  type BufferRow,
  type CommandMark,
  type CommandSelection,
  commandSummary,
  finishedMessage,
  isFailure,
  jumpTarget,
  type LastJump,
  logicalLines,
  LONG_COMMAND_MS,
  type MarkInfo,
  markKey,
  MarkRing,
  MAX_COMMAND_ROWS,
  moveSelection,
  navigable,
  outputRange,
  referenceLine,
  type RowRange,
  rulerMark,
  stickyMark,
} from "./marks";
import { holdsPress, isDrag, replayInit } from "./mouse-select";
import {
  parseOsc9,
  parseOsc52,
  parseOsc777,
  phaseAfter133,
  sameProgress,
  type ShellPhase,
  shiftEnterSequence,
} from "./osc";
import { paintNow } from "./paint";
import { asksBeforePaste, cleanPaste } from "./paste";
import { createReadiness } from "./readiness";
import { findInRows, MAX_SCOPED_HIGHLIGHTS, nextMatch, type ScopedMatch } from "./scoped-find";
import { lookOptions, type MarkColors, readMarkColors, readTheme } from "./theme";
import { displayTitle } from "./title";

/**
 * N-03: the PTY is resized once the size has been the same this long (a drag's steps come a
 * frame apart; a slow drag pauses longer, and each PTY resize makes the shell redraw).
 */
const RESIZE_SETTLE_MS = 100;
const SCROLLBACK_LINES = 10_000;
/** The gutter dot's size (CSS px). */
const MARK_DOT_PX = 6;
/** The overview ruler's width, which xterm also gives its scrollbar (the ruler lies on its track). */
const OVERVIEW_RULER_WIDTH = 14;
/** Keys that only modify others (they don't end a Shift+Ctrl+Up/Down selection). */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta"]);
/** macOS uses Cmd where Windows and Linux use Ctrl (copy, paste, find, links, prompt jumps). */
const APPLE = isApple();
/** N-03: a plain right-click copies or pastes on Windows; elsewhere it opens the menu. */
const QUICK_RIGHT_CLICK = isWindows();

/** The shell a view started, once it is ready. */
export interface ReadyShell {
  /** N-06: its profile (the default when the panel's is gone): the agent line is quoted for it. */
  readonly profileId: string;
}

export interface TerminalEvents {
  readonly onTitle: (title: string) => void;
  /** The shell reported its folder. */
  readonly onCwd: (cwd: string) => void;
  /** The shell this view started is ready for input (its first prompt). Once; never for a
   * running shell the view attached to (`terminal/readiness.ts`). */
  readonly onReady: (shell: ReadyShell) => void;
  /** N-06: the agent started with `startAgent` (by this view or an earlier one) has ended:
   * the shell is back at its prompt. */
  readonly onAgentExit: () => void;
  /** N-06: a view attached to a session whose agent works now (later changes are events). */
  readonly onAgentWorking: () => void;
  readonly onExit: (code: number | null) => void;
  /** The program wants the user: OSC 9 / OSC 777, the bell, a command the user asked about. */
  readonly onAttention: (message: string) => void;
  /** OSC 9;4 progress; `undefined` clears it. Only when it changes. */
  readonly onProgress: (progress: TerminalProgress | undefined) => void;
  /** The user asked to search (Ctrl+Shift+F, Cmd+Shift+F on macOS). */
  readonly onFind: () => void;
  /** How many matches the current search has, and which one is active (0-based, -1: none). */
  readonly onFindResults: (index: number, count: number) => void;
  /**
   * A multi-line paste into a shell without bracketed paste could run each line as a command:
   * the panel asks first and calls `paste` when the user agrees.
   */
  readonly onConfirmPaste: (text: string, paste: () => void) => void;
  /** The user clicked a command's gutter dot; `at` is the dot's box (client coordinates). */
  readonly onMarkMenu: (
    info: MarkInfo,
    at: { readonly left: number; readonly top: number; readonly bottom: number },
  ) => void;
  /**
   * The command whose output the top of the viewport is in (its prompt scrolled out of view),
   * `undefined` when none. Only when it changes, at most once per frame.
   */
  readonly onSticky: (info: MarkInfo | undefined) => void;
  /**
   * N-03: the user asked for the terminal's menu (Shift+right-click, Shift+F10 or the Menu key;
   * a right-click outside Windows) at `at` (client coordinates).
   */
  readonly onContextMenu: (at: { readonly x: number; readonly y: number }) => void;
}

export interface TerminalStart {
  readonly panelId: string;
  readonly profile: string | undefined;
  readonly cwd: string | undefined;
  /** On screen now (its tab is shown). */
  readonly visible: boolean;
  /** An agent runs here now: a drag selects in WolfCmd even while the agent tracks the mouse. */
  readonly agentPanel: () => boolean;
  /** The image-paste key of the agent running here now (`alt+v`); read at each paste. */
  readonly imagePaste: () => string | undefined;
  /** The shell's folder now, for relative file links. */
  readonly folder: () => string | undefined;
}

/** How the terminal looks and behaves: the user's settings and an agent panel's color. */
export interface TerminalLook {
  readonly appearance: FullSettings["appearance"];
  readonly kittyKeyboard: boolean;
  /** The agent's color (a CSS color) while an agent runs here; `undefined` for a shell. */
  readonly agentColor: string | undefined;
}

/** What the find bar searches with. */
export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly regex: boolean;
}

export interface TerminalView {
  focus(): void;
  /** N-06: types agent `agentId`'s start line (the core then watches it work and end). */
  startAgent(line: string, agentId: string): void;
  /** The user changed the settings, the theme changed, or the agent's color did. */
  setLook(look: TerminalLook): void;
  /** Its tab was shown or hidden: a hidden terminal gives back its WebGL context. */
  setVisible(visible: boolean): void;
  /** Moves to the next (or previous) match of `query`; highlights all of them. */
  find(query: string, options: FindOptions, backwards: boolean): void;
  /** Removes the highlights (the find bar closed). */
  clearFind(): void;
  /** The find bar searches only this command's output (`undefined`: everything). */
  scopeFind(id: number | undefined): void;
  /** Pastes like the user's own paste (bracketed when asked, the multi-line guard), then focuses. */
  paste(text: string): void;
  /** N-03: whether text is selected (the menu's Copy). */
  hasSelection(): boolean;
  /** N-03: copies the selection, then focuses. */
  copySelection(): void;
  /** N-03: pastes the clipboard as a right-click does (text, or a picture for an agent). */
  pasteClipboard(): void;
  /** N-03: selects the whole buffer. */
  selectAll(): void;
  /** N-03: clears the scrollback and the screen above the prompt; the shell keeps running. */
  clear(): void;
  /** The profile of the shell that runs (once it does), for quoting dropped paths. */
  profileId(): string | undefined;
  /** A command (by `id`; the last one that ran when absent), if it is still known. */
  command(id?: number): MarkInfo | undefined;
  /** A command's line or its whole output, for the clipboard. */
  commandText(id: number, part: "command" | "output"): string | undefined;
  /** Whether a command printed anything (or is printing). */
  hasOutput(id: number): boolean;
  /** The shell waits at an idle prompt on the normal screen (Rerun may type). */
  idlePrompt(): boolean;
  /** Types the command at the idle prompt, without Enter. `false` when it can't. */
  rerun(id: number): boolean;
  /** Scrolls the command's prompt to the top. */
  revealCommand(id: number): void;
  /** Selects the command's output (Ctrl+C then copies it). */
  selectOutput(id: number): void;
  /** Asks for attention when the running command `id` ends. */
  notifyWhenDone(id: number): void;
  /** The view is gone; its shell keeps running in the core. */
  dispose(): void;
}

/** Mounts a terminal into `host` and connects it to its panel's shell (running or new). */
export function mountTerminal(
  host: HTMLElement,
  start: TerminalStart,
  initialLook: TerminalLook,
  events: TerminalEvents,
): TerminalView {
  let look = initialLook;
  const term = new Terminal({
    allowProposedApi: true, // required by the Unicode 11 addon
    ...lookOptions(look.appearance),
    scrollback: SCROLLBACK_LINES,
    theme: readTheme(document.documentElement, look.agentColor),
    // Command dots (and find matches) next to the scrollbar.
    overviewRuler: { width: OVERVIEW_RULER_WIDTH, showTopBorder: false, showBottomBorder: false },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  const searchResults = search.onDidChangeResults(({ resultIndex, resultCount }) => {
    events.onFindResults(resultIndex, resultCount);
  });
  // Ctrl+click (Cmd+click on macOS) opens links: URLs, OSC 8 hyperlinks and file paths
  // (`path:line:col`); the core decides how and never runs a program.
  const openUrl = (event: MouseEvent, uri: string) => {
    if (primaryModifier(event, APPLE)) openLink(uri);
  };
  term.loadAddon(new WebLinksAddon(openUrl));
  // N-02: an OSC 8 link's text can differ from its target: hovering shows where it goes.
  term.options.linkHandler = {
    activate: openUrl,
    hover: (_event, uri) => {
      host.title = uri;
    },
    leave: () => {
      host.removeAttribute("title");
    },
    allowNonHttpProtocols: false,
  };
  const fileLinks = term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links: ILink[] = findPaths(text).map((match) => ({
        text: match.text,
        range: {
          start: { x: match.start + 1, y },
          end: { x: match.start + match.text.length, y },
        },
        decorations: { underline: true, pointerCursor: true },
        activate(event) {
          if (!primaryModifier(event, APPLE)) return;
          openLink(match.path, { line: match.line, column: match.column, cwd: start.folder() });
        },
      }));
      callback(links.length > 0 ? links : undefined);
    },
  });
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = "11";
  term.open(host);
  const gpu = createGpu(term, host);
  if (start.visible) gpu.show();
  fit.fit();

  let session: TerminalSession | undefined;
  let exited = false;
  let disposed = false;
  const pending: string[] = [];
  const send = (data: string) => {
    if (session) session.write(data);
    else if (!exited) pending.push(data);
  };

  // Every keystroke goes straight to the PTY, unbatched.
  const input = term.onData(send);

  // N-03: the shell reflows once, when the size has settled: the PTY learns the size after it
  // stayed the same for a while (or right after a divider is released), and only if it differs
  // from the size the shell has. Every PTY resize makes ConPTY repaint and the shell redraw.
  let ptySize = { cols: term.cols, rows: term.rows };
  const sendSize = (cols: number, rows: number) => {
    if (session === undefined || (cols === ptySize.cols && rows === ptySize.rows)) return;
    ptySize = { cols, rows };
    session.resize(cols, rows);
  };
  const resizePty = debounce(sendSize, RESIZE_SETTLE_MS);
  const resized = term.onResize(({ cols, rows }) => {
    resizePty.call(cols, rows);
  });
  // A released pointer ends a divider drag: the size is final once the next frame is laid out.
  let releaseFrame = 0;
  const onRelease = () => {
    if (!resizePty.pending()) return;
    cancelAnimationFrame(releaseFrame);
    releaseFrame = requestAnimationFrame(() => {
      releaseFrame = requestAnimationFrame(() => {
        releaseFrame = 0;
        resizePty.flush();
      });
    });
  };
  window.addEventListener("pointerup", onRelease, true);

  let shown = start.visible;
  /** N-03: fits the terminal to its box and paints it in the same frame (`paint.ts`). */
  const refit = () => {
    // A hidden terminal keeps its size (and its shell its layout) until it is shown again.
    if (!shown || host.clientWidth === 0 || host.clientHeight === 0) return;
    const before = `${String(term.cols)}x${String(term.rows)}`;
    fit.fit();
    if (`${String(term.cols)}x${String(term.rows)}` !== before) paintNow(term);
    // The box still moves: the settle time starts again, even when the cell count didn't change.
    if (resizePty.pending()) resizePty.call(term.cols, term.rows);
  };
  // N-03: refit inside the observer, before the frame is painted: at most once per frame (the
  // observer runs once per frame) and never a frame late. A 0×0 box (minimized, parked) is left
  // alone, so the terminal keeps its size and text.
  const observer = new ResizeObserver(refit);
  observer.observe(host);
  // xterm stops painting while the terminal is off screen and paints again a frame after it is
  // back; this observer, created after xterm's, paints in the frame it comes back.
  const screenElement = host.querySelector(".xterm-screen");
  const onScreen = new IntersectionObserver((entries) => {
    if (shown && entries.some((entry) => entry.isIntersecting)) paintNow(term);
  });
  if (screenElement !== null) onScreen.observe(screenElement);

  // xterm draws the IME's text being composed at the cursor in white on black; give it the
  // terminal's colors and an underline, like Windows Terminal.
  const composition = host.querySelector<HTMLElement>(".composition-view");
  const paintComposition = (theme: ITheme) => {
    if (!composition) return;
    composition.style.background = theme.background ?? "";
    composition.style.color = theme.foreground ?? "";
    composition.style.textDecoration = "underline";
  };
  paintComposition(term.options.theme ?? {});

  // Command marks: the last commands as xterm markers on the normal buffer (they follow the
  // lines as the buffer scrolls and go with trimmed lines). Set only at OSC 133 marks, never
  // per output chunk.
  const decorations = new Map<number, IDecoration>();
  const marks = new MarkRing<IMarker>(undefined, (mark) => {
    decorations.get(mark.id)?.dispose();
    decorations.delete(mark.id);
  });
  const onNormalScreen = () => term.buffer.active.type === "normal";
  const cursorLine = () => term.buffer.normal.baseY + term.buffer.normal.cursorY;
  /** Rows `from`…`to` of the normal buffer (the first from column `x`, the last up to `toX`). */
  const rows = (from: number, to: number, x: number, toX?: number): BufferRow[] => {
    const buffer = term.buffer.normal;
    const result: BufferRow[] = [];
    for (let y = Math.max(0, from); y <= to; y += 1) {
      const line = buffer.getLine(y);
      if (line) {
        result.push({
          text: line.translateToString(false, y === from ? x : 0, y === to ? toX : undefined),
          wrapped: line.isWrapped,
        });
      }
    }
    return result;
  };
  const rangeRows = (range: RowRange): BufferRow[] =>
    rows(range.from, range.to, range.fromX, range.toX);
  /** The command line the user typed (after the prompt, up to the output); "" when unknown. */
  const readCommand = (mark: CommandMark<IMarker> | undefined): string => {
    const begin = mark?.output;
    const from = mark?.promptEnd;
    if (begin === undefined || begin.line < 0 || from === undefined || from.marker.line < 0) {
      return "";
    }
    if (begin.line - from.marker.line > MAX_COMMAND_ROWS) return "";
    return logicalLines(rows(from.marker.line, begin.line - 1, from.x)).join("\n");
  };
  /** Where a command's output is now (to the cursor while it runs). */
  const outputOf = (mark: CommandMark<IMarker>): RowRange | undefined =>
    outputRange(mark, marks.after(mark), cursorLine());

  // The gutter dots' and the ruler's colors (the ruler is a canvas: it needs the values, read
  // again when the theme changes).
  let colors: MarkColors = readMarkColors();
  // A calm dot in the left padding at each command's prompt (neutral, hollow while it runs,
  // red-toned when it failed) and the same on the overview ruler. xterm calls `onRender` for
  // every drawn decoration on every frame, so painting only writes when the look changed.
  const rulerOf = (mark: CommandMark<IMarker>) => rulerMark(mark.exitCode, colors);
  const paintMark = (element: HTMLElement, mark: CommandMark<IMarker>, force: boolean) => {
    const state = marks.stateOf(mark);
    const failed = isFailure(mark.exitCode);
    const lookKey = failed ? "failed" : state;
    if (!force && element.dataset.wcMark === lookKey) return;
    element.dataset.wcMark = lookKey;
    let dot = element.firstElementChild as HTMLElement | null;
    if (dot === null) {
      // Into the terminal's left padding (`--wc-term-pad-x`), never over text.
      element.style.marginLeft = "calc(-1 * var(--wc-term-pad-x))";
      element.style.cursor = "default";
      dot = document.createElement("span");
      Object.assign(dot.style, {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: `${String(MARK_DOT_PX)}px`,
        height: `${String(MARK_DOT_PX)}px`,
        borderRadius: "9999px",
        transform: "translate(-50%, -50%)",
        transition: "opacity var(--wc-dur-fast) var(--wc-ease-out)",
        // High contrast would paint the dot's background away; keep the token colors.
        forcedColorAdjust: "none",
      });
      element.append(dot);
      // A press must neither start a selection nor take the focus from the shell.
      element.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        const live = marks.get(mark.id);
        if (live === undefined) return;
        const box = element.getBoundingClientRect();
        events.onMarkMenu(marks.info(live), { left: box.left, top: box.top, bottom: box.bottom });
      });
    }
    dot.style.background = failed
      ? "var(--wc-danger)"
      : state === "running"
        ? "transparent"
        : "var(--wc-fg-muted)";
    dot.style.boxShadow =
      state === "running" && !failed ? "inset 0 0 0 1px var(--wc-fg-muted)" : "";
    dot.style.opacity = failed ? "0.9" : "0.55";
    const command = commandSummary(mark.command) || "A command";
    element.title =
      state === "running"
        ? `${command} is running. Click for actions.`
        : mark.exitCode === undefined
          ? `${command}. Click for actions.`
          : `${command}: exit code ${String(mark.exitCode)}. Click for actions.`;
  };
  const decorate = (mark: CommandMark<IMarker>, force = false) => {
    const existing = decorations.get(mark.id);
    if (existing !== undefined) {
      existing.options.overviewRulerOptions = rulerOf(mark);
      if (existing.element) paintMark(existing.element, mark, force);
      return;
    }
    if (mark.prompt.isDisposed) return;
    const decoration = term.registerDecoration({
      marker: mark.prompt,
      overviewRulerOptions: rulerOf(mark),
    });
    if (decoration === undefined) return;
    decorations.set(mark.id, decoration);
    decoration.onRender((element) => {
      if (element.style.display !== "none") paintMark(element, mark, false);
    });
  };

  // The sticky command header follows the viewport (at most once per frame, and no work at
  // all while the terminal follows its output at the bottom).
  let stickyKey = "";
  let stickyFrame = 0;
  const updateSticky = () => {
    stickyFrame = 0;
    const buffer = term.buffer.active;
    const mark = buffer.type === "normal" ? stickyMark(marks.live(), buffer) : undefined;
    const info = mark === undefined ? undefined : marks.info(mark);
    const key =
      info === undefined ? "" : `${String(info.id)}:${info.state}:${String(info.exitCode)}`;
    if (key === stickyKey) return;
    stickyKey = key;
    events.onSticky(info);
  };
  const queueSticky = () => {
    const buffer = term.buffer.active;
    if (stickyKey === "" && buffer.viewportY >= buffer.baseY) return;
    if (stickyFrame === 0) stickyFrame = requestAnimationFrame(updateSticky);
  };
  const scrolled = term.onScroll(queueSticky);
  const screenChanged = term.buffer.onBufferChange(queueSticky);

  // Ctrl+Up/Down and Shift+Ctrl+Up/Down. The last jump (so a prompt near the bottom, which
  // can't scroll to the top, isn't jumped to twice) and the commands Shift selects.
  let lastJump: LastJump | undefined;
  let commandSelection: CommandSelection | undefined;
  const scrollToPrompt = (line: number) => {
    term.scrollToLine(line);
    lastJump = { line, viewportY: term.buffer.active.viewportY };
  };
  const navigate = (key: "up" | "down" | "selectUp" | "selectDown") => {
    const list = navigable(marks);
    const lines = list.map((mark) => mark.prompt.line);
    const buffer = term.buffer.normal;
    const view = {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      cursorLine: buffer.baseY + buffer.cursorY,
    };
    const current = marks.current();
    const waiting =
      current !== undefined && marks.stateOf(current) === "prompt" ? current : undefined;
    const direction = key === "up" || key === "selectUp" ? "up" : "down";
    const target = (): number | undefined =>
      jumpTarget(lines, referenceLine(view, lastJump, waiting), direction);
    if (key === "up" || key === "down") {
      commandSelection = undefined;
      const line = target();
      if (line !== undefined) scrollToPrompt(line);
      else if (direction === "down") {
        term.scrollToBottom();
        lastJump = undefined;
      }
      return;
    }
    let first: number | undefined;
    if (commandSelection === undefined) {
      const line = target();
      first = line === undefined ? undefined : lines.indexOf(line);
    }
    commandSelection = moveSelection(commandSelection, direction, first, list.length);
    if (commandSelection === undefined) return;
    const anchor = Math.min(commandSelection.anchor, list.length - 1);
    const top = list[Math.min(anchor, commandSelection.focus)];
    const bottom = list[Math.max(anchor, commandSelection.focus)];
    const focus = list[commandSelection.focus];
    if (top === undefined || bottom === undefined || focus === undefined) return;
    const from = blockRange(top, marks.after(top), view.cursorLine);
    const to = blockRange(bottom, marks.after(bottom), view.cursorLine);
    if (from === undefined || to === undefined) return;
    term.selectLines(from.start, to.end);
    scrollToPrompt(focus.prompt.line);
  };

  // Find, everywhere (the search addon) or in one command's output (scoped).
  const searchOptions = (options: FindOptions): ISearchOptions => ({
    caseSensitive: options.caseSensitive,
    regex: options.regex,
    decorations: {
      matchBackground: colors.match,
      activeMatchBackground: colors.activeMatch,
      matchOverviewRuler: colors.activeMatch,
      activeMatchColorOverviewRuler: colors.activeMatch,
    },
  });
  let findScope: number | undefined;
  let scoped:
    | {
        readonly key: string;
        readonly matches: readonly ScopedMatch[];
        active: number;
        readonly highlights: IDecoration[];
      }
    | undefined;
  const clearScoped = () => {
    for (const highlight of scoped?.highlights ?? []) {
      highlight.marker.dispose();
      highlight.dispose();
    }
    scoped = undefined;
  };
  const findScoped = (query: string, options: FindOptions, backwards: boolean) => {
    const mark = findScope === undefined ? undefined : marks.get(findScope);
    const key = JSON.stringify([query, options.caseSensitive, options.regex]);
    let state = scoped;
    if (state?.key !== key) {
      clearScoped();
      const range = mark === undefined || !onNormalScreen() ? undefined : outputOf(mark);
      const matches =
        range === undefined ? [] : findInRows(rangeRows(range), range.from, query, options);
      const highlights: IDecoration[] = [];
      const cursor = cursorLine();
      for (const match of matches.slice(0, MAX_SCOPED_HIGHLIGHTS)) {
        const marker = term.registerMarker(match.row - cursor);
        const highlight = term.registerDecoration({
          marker,
          x: match.col,
          width: Math.max(1, Math.min(match.length, term.cols - match.col)),
          backgroundColor: colors.match,
          overviewRulerOptions: { color: colors.activeMatch, position: "center" },
        });
        if (highlight === undefined) marker.dispose();
        else highlights.push(highlight);
      }
      state = { key, matches, active: -1, highlights };
      scoped = state;
    }
    state.active = nextMatch(state.active, state.matches.length, backwards);
    const match = state.matches[state.active];
    if (match !== undefined) {
      term.select(match.col, match.row, match.length);
      const top = term.buffer.active.viewportY;
      if (match.row < top || match.row >= top + term.rows) {
        term.scrollToLine(Math.max(0, match.row - Math.floor(term.rows / 3)));
      }
    } else {
      term.clearSelection();
    }
    events.onFindResults(state.active, state.matches.length);
  };

  // The Kitty keyboard protocol's flag stacks, one per screen (the spec's rule), while the
  // setting is on. Off until the program pushes flags; reset at the shell's next prompt
  // (OSC 133;A) and on a full reset, so a program that crashed with it on never leaves the
  // shell with encoded keys.
  const kitty: Record<"normal" | "alternate", KittyStack> = { normal: [], alternate: [] };
  const resetKitty = () => {
    kitty.normal = [];
    kitty.alternate = [];
  };
  const kittyScreen = () => term.buffer.active.type;
  const kittyNow = () => kittyFlags(kitty[kittyScreen()]);

  // Whether a program runs (OSC 133 marks), for Shift+Enter; the first prompt is "ready".
  let phase: ShellPhase = "unknown";
  let commandStartedAt: number | undefined;
  let notifyId: number | undefined;
  let progress: TerminalProgress | undefined;
  const readiness = createReadiness(() => {
    if (!disposed && session) events.onReady({ profileId: session.profileId });
  });
  const onPrompt = (data: string) => {
    const before = phase;
    phase = phaseAfter133(data, phase);
    // Marks only on the normal screen (a TUI's screen has no commands of its own).
    const track = onNormalScreen();
    const kind = data.charAt(0);
    if (kind === "A") {
      resetKitty();
      if (track) {
        const previous = marks.current();
        marks.prompt(() => term.registerMarker(0));
        // A shell without command starts (cmd): its earlier prompt is a command too.
        if (previous !== undefined && marks.get(previous.id) !== undefined) decorate(previous);
      }
    } else if (kind === "B") {
      readiness.prompt();
      if (track) marks.promptEnd(() => term.registerMarker(0), term.buffer.normal.cursorX);
    } else if (kind === "C") {
      // The line editor ends the command line with a newline before `C`; if the cursor is
      // still in the middle of a line, the output starts on the next one.
      const mark = track
        ? marks.outputStart(() => term.registerMarker(term.buffer.normal.cursorX > 0 ? 1 : 0))
        : undefined;
      if (mark !== undefined) {
        // Read now, while the markers are surely in the buffer.
        mark.command = readCommand(mark);
        decorate(mark);
      }
      commandStartedAt = Date.now();
    } else if (kind === "D") {
      const code = Number(data.split(";")[1]);
      const exitCode = Number.isFinite(code) ? code : undefined;
      const mark = track ? marks.current() : undefined;
      if (mark !== undefined) {
        const ended = marks.end(
          () => ({ marker: term.registerMarker(0), x: term.buffer.normal.cursorX }),
          exitCode,
        );
        if (ended !== undefined) decorate(ended);
      }
      const took =
        before === "running" && commandStartedAt !== undefined
          ? Date.now() - commandStartedAt
          : undefined;
      const command = mark?.command ?? "";
      if (mark !== undefined && notifyId === mark.id) {
        events.onAttention(finishedMessage(command, exitCode));
      } else if (took !== undefined && took >= LONG_COMMAND_MS && !start.agentPanel()) {
        // The panel's store ignores it while the user is looking at this panel.
        events.onAttention(finishedMessage(command, exitCode, took));
      }
      notifyId = undefined;
      commandStartedAt = undefined;
      queueSticky();
    }
  };
  const osc = [
    term.parser.registerOscHandler(133, (data) => {
      onPrompt(data);
      return false; // the core reads the marks too
    }),
    term.parser.registerOscHandler(9, (data) => {
      const parsed = parseOsc9(data);
      if (parsed.kind === "notify") events.onAttention(parsed.message);
      if (parsed.kind === "progress" && !sameProgress(progress, parsed.progress)) {
        progress = parsed.progress;
        events.onProgress(progress);
      }
      return parsed.kind !== "other";
    }),
    term.parser.registerOscHandler(777, (data) => {
      const message = parseOsc777(data);
      if (message !== undefined) events.onAttention(message);
      return message !== undefined;
    }),
    term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data);
      if (text !== undefined) void navigator.clipboard.writeText(text);
      return true; // reads ("?") are swallowed: never answered (privacy)
    }),
  ];
  // Kitty keyboard requests: push (`CSI > flags u`), pop (`CSI < n u`), set
  // (`CSI = flags ; mode u`) and query (`CSI ? u`, answered with the flags in effect). With the
  // setting off they fall through to xterm (ignored), so programs see no protocol.
  const kittyRequests = [
    term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      if (!look.kittyKeyboard) return false;
      const screen = kittyScreen();
      kitty[screen] = kittyPush(kitty[screen], csiParam(params, 0) ?? 0);
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      if (!look.kittyKeyboard) return false;
      const screen = kittyScreen();
      kitty[screen] = kittyPop(kitty[screen], csiParam(params, 0) ?? 1);
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      if (!look.kittyKeyboard) return false;
      const screen = kittyScreen();
      kitty[screen] = kittySet(kitty[screen], csiParam(params, 0) ?? 0, csiParam(params, 1) ?? 1);
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
      if (!look.kittyKeyboard) return false;
      term.input(kittyQueryReply(kitty[kittyScreen()]), false);
      return true;
    }),
    term.parser.registerEscHandler({ final: "c" }, () => {
      resetKitty();
      return false; // xterm still does the full reset
    }),
  ];
  const bell = term.onBell(() => {
    events.onAttention("The program rang the bell");
  });

  term.attachCustomKeyEventHandler((event) => {
    // Keys an IME takes (composing Chinese, Japanese or Korean text) belong to xterm's
    // composition helper, which sends the committed text once. Nothing here may act on them.
    if (isImeKey(event)) return true;
    // Ctrl+Shift+F (Cmd+Shift+F on macOS) searches the scrollback; the F key on any layout.
    if (
      event.type === "keydown" &&
      primaryModifier(event, APPLE) &&
      event.shiftKey &&
      !event.altKey &&
      chordLetter(event) === "F"
    ) {
      event.preventDefault();
      events.onFind();
      return false;
    }
    // Ctrl+Up/Down jump between prompts, Shift+Ctrl+Up/Down select whole commands; only on the
    // normal screen and once there are marks (without shell integration the keys stay the
    // shell's).
    const navigation = markKey(event, term.buffer.active.type, APPLE);
    if (navigation !== undefined && marks.live().length > 0) {
      if (event.type === "keydown") {
        event.preventDefault();
        navigate(navigation);
      }
      return false;
    }
    if (event.type === "keydown" && !MODIFIER_KEYS.has(event.key)) commandSelection = undefined;
    if (!clipboardKey(term, event)) return false;
    // N-03: Ctrl+Shift+A selects all, Ctrl+Shift+K clears (Cmd+Shift on macOS).
    const edit = editKey(event, APPLE);
    if (edit !== undefined) {
      event.preventDefault();
      if (edit === "selectAll") term.selectAll();
      else term.clear();
      return false;
    }
    // A program that turned the Kitty keyboard protocol on gets its encoding.
    const sequence = look.kittyKeyboard ? encodeKittyKey(event, kittyNow()) : undefined;
    if (sequence !== undefined) {
      event.preventDefault(); // no keypress: the key must not also type its character
      term.input(sequence, true);
      return false;
    }
    // Shift+Enter is a newline in agent prompts (Meta+Enter), Enter at a shell prompt.
    if (
      event.type === "keydown" &&
      event.key === "Enter" &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      send(shiftEnterSequence(phase));
      return false;
    }
    return true;
  });

  // A multi-line paste into something that doesn't use bracketed paste (a shell prompt) could
  // run each line as a command: ask first. Agents use bracketed paste.
  // N-02: control characters are dropped first (`paste.ts`): a paste never ends the bracket early.
  const paste = (pasted: string) => {
    const text = cleanPaste(pasted);
    if (!text) return;
    if (asksBeforePaste(text, term.modes.bracketedPasteMode)) {
      events.onConfirmPaste(text, () => {
        term.paste(text);
      });
      return;
    }
    term.paste(text);
  };
  // A picture and no text in an agent's panel: press the agent's own image-paste key (as the
  // user's key would arrive), so the agent reads the clipboard itself.
  const pasteImage = (): boolean => {
    const chord = start.agentPanel() ? start.imagePaste() : undefined;
    const bytes = chord === undefined ? undefined : chordBytes(chord, kittyNow());
    if (bytes === undefined) return false;
    term.input(bytes, true);
    return true;
  };
  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    event.stopPropagation();
    if (text === "" && hasImage(event.clipboardData) && pasteImage()) return;
    paste(text);
  };
  host.addEventListener("paste", onPaste, { capture: true });
  const copySelection = () => {
    void navigator.clipboard.writeText(term.getSelection());
    term.clearSelection();
  };
  const pasteClipboard = () => {
    void clipboardText().then((text) => {
      if (text) paste(text);
      // No text: maybe a picture for the agent (it says so when there is none).
      else pasteImage();
    });
  };
  // N-03: a right-click copies the selection or pastes on Windows (like Windows Terminal); with
  // Shift, from the keyboard or elsewhere it opens the terminal's menu. A program tracking the
  // mouse gets a plain right-click (xterm reported it).
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    const action = rightClickAction({
      keyboard: isKeyboardMenu(event),
      shiftKey: event.shiftKey,
      tracking: term.modes.mouseTrackingMode,
      quick: QUICK_RIGHT_CLICK,
    });
    if (action === "menu") events.onContextMenu({ x: event.clientX, y: event.clientY });
    else if (action === "quick" && term.hasSelection()) copySelection();
    else if (action === "quick") pasteClipboard();
  };
  host.addEventListener("contextmenu", onContextMenu);
  // A mouse selection replaces the commands Shift+Ctrl+Up/Down selected.
  const onSelectStart = () => {
    commandSelection = undefined;
  };
  host.addEventListener("mousedown", onSelectStart);

  // In an agent panel whose program tracks the mouse, a press is held until it moves (a drag:
  // xterm selects at once) or is released (a click, replayed to the program unchanged).
  let held: MouseEvent | undefined;
  const replay = (type: "mousedown" | "mouseup", from: MouseEvent, select: boolean) => {
    const target = held?.target ?? from.target;
    target?.dispatchEvent(new MouseEvent(type, replayInit(from, select)));
  };
  const stopHolding = () => {
    held = undefined;
    window.removeEventListener("mousemove", onHeldMove, true);
    window.removeEventListener("mouseup", onHeldUp, true);
  };
  const onHeldMove = (event: MouseEvent) => {
    if (held === undefined) return;
    if (!isDrag({ x: held.clientX, y: held.clientY }, { x: event.clientX, y: event.clientY })) {
      return;
    }
    const press = held;
    stopHolding();
    term.clearSelection();
    replay("mousedown", press, true);
  };
  const onHeldUp = (event: MouseEvent) => {
    if (held === undefined) return;
    const press = held;
    replay("mousedown", press, false);
    replay("mouseup", event, false);
    stopHolding();
  };
  const onPressCapture = (event: MouseEvent) => {
    const onScreen = event.target instanceof Element && event.target.closest(".xterm-screen");
    const context = { agentPanel: start.agentPanel(), tracking: term.modes.mouseTrackingMode };
    if (!onScreen || !holdsPress(event, context)) return;
    event.preventDefault();
    event.stopPropagation();
    stopHolding();
    held = event;
    term.focus();
    window.addEventListener("mousemove", onHeldMove, true);
    window.addEventListener("mouseup", onHeldUp, true);
  };
  host.addEventListener("mousedown", onPressCapture, { capture: true });

  const titles = term.onTitleChange((title) => {
    if (title.trim()) events.onTitle(displayTitle(title));
  });

  // The replay of a running shell or a new shell's first output may come before the open
  // returns; nothing reaches a disposed view.
  const opened = { cols: term.cols, rows: term.rows };
  ptySize = opened;
  openTerminal({
    ...opened,
    profile: start.profile,
    cwd: start.cwd,
    panelId: start.panelId,
    // N-06: a view disposed before its turn (StrictMode) never starts the shell.
    cancelled: () => disposed,
    onOutput: (data, done) => {
      if (!disposed) term.write(data, done);
    },
    onCwd: (cwd) => {
      if (!disposed) events.onCwd(cwd);
    },
    onAgentExit: () => {
      if (!disposed) events.onAgentExit();
    },
    onExit: (code) => {
      if (disposed) return;
      exited = true;
      session = undefined;
      term.write(
        `\r\n\x1b[2m[process exited${code === null ? "" : ` with code ${String(code)}`}]\x1b[0m\r\n`,
      );
      if (progress !== undefined) {
        progress = undefined;
        events.onProgress(undefined);
      }
      events.onExit(code);
    },
  })
    .then((started) => {
      if (disposed) {
        started.detach();
        return;
      }
      session = started;
      for (const data of pending.splice(0)) started.write(data);
      // The size may have changed while the session was opening (N-03: sent only if it did).
      sendSize(term.cols, term.rows);
      // N-06: the agent ended while no view was attached (a reload, a hang).
      if (started.agentExited) events.onAgentExit();
      if (started.agentWorking) events.onAgentWorking();
      readiness.started(started.attached, started.integrated);
    })
    .catch((error: unknown) => {
      if (disposed) return;
      exited = true;
      term.write(`\x1b[31mCould not start the shell: ${String(error)}\x1b[0m\r\n`);
    });

  /** The shell waits for a command on the normal screen (no program runs). */
  const idlePrompt = (): boolean => {
    const current = marks.current();
    return (
      session !== undefined &&
      !exited &&
      phase === "prompt" &&
      onNormalScreen() &&
      current !== undefined &&
      marks.stateOf(current) === "prompt"
    );
  };

  return {
    focus() {
      term.focus();
    },
    startAgent(line, agentId) {
      session?.startAgent(line, agentId);
    },
    setLook(next) {
      const kittyOff = look.kittyKeyboard && !next.kittyKeyboard;
      look = next;
      if (kittyOff) resetKitty();
      term.options = lookOptions(next.appearance);
      const theme = readTheme(document.documentElement, next.agentColor);
      term.options.theme = theme;
      paintComposition(theme);
      colors = readMarkColors();
      for (const mark of marks.live()) decorate(mark, true);
      // A hidden terminal keeps its size: the DOM renderer measures cells a little differently,
      // and its shell would be resized now and again when it is shown (`setVisible` refits).
      if (shown && host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
      // Fonts and sizes resize the canvas: paint it in this frame (N-03).
      if (shown) paintNow(term);
    },
    setVisible(visible) {
      shown = visible;
      if (visible) {
        // N-03: the WebGL canvas, painted at once, then a size the box got while hidden (measured
        // with WebGL's cells: the DOM renderer's differ by a fraction, which would reflow).
        gpu.show();
        refit();
      } else {
        gpu.hide();
        // A hidden terminal never keeps the keyboard: the shown tab's keys (the empty tab's
        // Enter, typing) would go to its shell. The browser moves the focus off a hidden element
        // only at some later style update.
        if (term.textarea !== undefined && term.textarea === document.activeElement) term.blur();
      }
    },
    find(query, options, backwards) {
      if (findScope !== undefined) {
        findScoped(query, options, backwards);
        return;
      }
      if (!query) {
        search.clearDecorations();
        events.onFindResults(-1, 0);
        return;
      }
      if (backwards) search.findPrevious(query, searchOptions(options));
      else search.findNext(query, { ...searchOptions(options), incremental: true });
    },
    clearFind() {
      search.clearDecorations();
      clearScoped();
      findScope = undefined;
      term.clearSelection();
    },
    scopeFind(id) {
      clearScoped();
      search.clearDecorations();
      findScope = id;
    },
    paste(text) {
      paste(text);
      term.focus();
    },
    hasSelection() {
      return term.hasSelection();
    },
    copySelection() {
      copySelection();
      term.focus();
    },
    pasteClipboard() {
      pasteClipboard();
      term.focus();
    },
    selectAll() {
      term.selectAll();
      term.focus();
    },
    clear() {
      term.clear();
      term.focus();
    },
    profileId() {
      return session?.profileId;
    },
    command(id) {
      const mark = id === undefined ? marks.lastCommand() : marks.get(id);
      return mark === undefined ? undefined : marks.info(mark);
    },
    commandText(id, part) {
      const mark = marks.get(id);
      if (mark === undefined) return undefined;
      if (part === "command") return mark.command.trim() === "" ? undefined : mark.command.trim();
      const range = outputOf(mark);
      if (range === undefined) return undefined;
      // The whole output (a user's copy, bounded by the scrollback), without padding.
      return logicalLines(rangeRows(range))
        .join("\n")
        .replace(/^\n+|\n+$/g, "");
    },
    hasOutput(id) {
      const mark = marks.get(id);
      const range = mark === undefined ? undefined : outputOf(mark);
      return range !== undefined && range.to >= range.from;
    },
    idlePrompt,
    rerun(id) {
      const command = marks.get(id)?.command.trim() ?? "";
      if (command === "" || command.includes("\n") || !idlePrompt() || !session) return false;
      session.write(command); // typed, never run: the user presses Enter
      term.scrollToBottom();
      term.focus();
      return true;
    },
    revealCommand(id) {
      const mark = marks.get(id);
      if (mark === undefined || mark.prompt.line < 0 || !onNormalScreen()) return;
      scrollToPrompt(mark.prompt.line);
      term.focus();
    },
    selectOutput(id) {
      const mark = marks.get(id);
      const range = mark === undefined || !onNormalScreen() ? undefined : outputOf(mark);
      if (range === undefined || range.to < range.from) return;
      term.selectLines(range.from, range.to);
      if (range.from < term.buffer.active.viewportY) scrollToPrompt(range.from);
      term.focus();
    },
    notifyWhenDone(id) {
      const mark = marks.get(id);
      if (mark !== undefined && marks.stateOf(mark) === "running") notifyId = id;
      term.focus();
    },
    dispose() {
      disposed = true;
      // Only the view goes: the shell (an agent at work in it) keeps running in the core.
      session?.detach();
      session = undefined;
      readiness.dispose();
      resizePty.cancel();
      cancelAnimationFrame(releaseFrame);
      window.removeEventListener("pointerup", onRelease, true);
      onScreen.disconnect();
      cancelAnimationFrame(stickyFrame);
      observer.disconnect();
      input.dispose();
      resized.dispose();
      titles.dispose();
      bell.dispose();
      searchResults.dispose();
      fileLinks.dispose();
      scrolled.dispose();
      screenChanged.dispose();
      for (const handler of osc) handler.dispose();
      for (const handler of kittyRequests) handler.dispose();
      host.removeEventListener("paste", onPaste, { capture: true });
      host.removeEventListener("contextmenu", onContextMenu);
      host.removeEventListener("mousedown", onSelectStart);
      host.removeEventListener("mousedown", onPressCapture, { capture: true });
      stopHolding();
      clearScoped();
      marks.dispose();
      // The WebGL context goes with the terminal (no DOM renderer built just to be disposed).
      gpu.dispose(() => {
        term.dispose();
      });
    },
  };
}

/**
 * Windows Terminal's clipboard keys: Ctrl+C copies when there's a selection (else it's ^C),
 * Ctrl+Shift+C always copies, Ctrl+V / Ctrl+Shift+V paste through the paste event (never ^V).
 * On macOS Cmd+C copies and Cmd+V pastes, and Ctrl+C is always ^C. The C and V keys on any
 * layout (Ukrainian С and М too). `false`: the key was handled.
 */
function clipboardKey(term: Terminal, event: KeyboardEvent): boolean {
  if (event.type !== "keydown" || event.altKey) return true;
  const primary = APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return true;
  const letter = chordLetter(event);
  if (letter === "C" && (APPLE || event.shiftKey || term.hasSelection())) {
    const selection = term.getSelection();
    if (selection) void navigator.clipboard.writeText(selection);
    term.clearSelection();
    event.preventDefault();
    return false;
  }
  return letter !== "V";
}
