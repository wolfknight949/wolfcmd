// N-02 / N-06: a terminal panel (N-03: the view of the terminal panel type, `TerminalType`;
// its saved fields are `panel.content`, a `TerminalContent`). The xterm view is mounted once per panel (moving the panel
// never remounts it); an agent panel types its agent's start or resume line at the first prompt
// of a shell it started, never into a running one it attached to (a reload, a remount). A
// restored panel whose agent had ended is a plain shell: nothing is typed.
//
// Around the view: the find bar, the multi-line paste guard, the sticky command header and a
// command's menu (React state that changes only on the user's actions and at command marks,
// never per output chunk), the agent's color while an agent runs, dropped files, and N-03 the
// terminal's context menu (`TerminalMenu`).
import type { AgentStart } from "@wolfcmd/bindings";
import type { MenuPoint } from "@wolfcmd/ui-kit";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { agentCommand, listAgents } from "../core/agents";
import { relaunches, restoreStart, startFolder, withAgent } from "../model/agents";
import { agentOf, panelFolder, terminalOf, withCwd } from "../model/panels";
import { remoteControlName } from "../model/remote-control";
import { agentWorking } from "../store/activity";
import { continuing, freshAgents } from "../store/agent-starts";
import { clearAttention, requestAttention, setProgress } from "../store/attention";
import { commandRunning } from "../store/commands";
import type { FullSettings } from "../store/settings";
import { setTitle } from "../store/titles";
import { dropTarget, dropText } from "../terminal/drop";
import { commandSummary, markActions, type MarkActions, type MarkInfo } from "../terminal/marks";
import {
  type FindOptions,
  mountTerminal,
  type TerminalLook,
  type TerminalView,
} from "../terminal/terminal-view";
import { agentColor } from "../terminal/theme";
import { setDropHandler } from "./file-drops";
import { FindBar } from "./FindBar";
import { type MarkAction, MarkMenu } from "./MarkMenu";
import { PasteConfirm } from "./PasteConfirm";
import { TerminalMenu, type TerminalMenuAction } from "./TerminalMenu";
import { paintSticky, StickyHeader } from "./StickyHeader";
import type { PanelViewProps } from "./types";

/** The running agent's look and keys, from `agent_list`. */
interface AgentLook {
  /** Its palette slot (`--wc-workspace-<n>`): resolved against the theme each time it is used. */
  readonly slot: number;
  readonly imagePaste: string | undefined;
}

interface OpenMenu {
  readonly info: MarkInfo;
  readonly actions: MarkActions;
  readonly left: number;
  readonly top: number;
}

/**
 * The look for the settings, and the agent's color while an agent runs in the panel: read from the
 * theme now (agent colors differ between the themes), so a restyle after a theme change is right.
 */
function lookOf(settings: FullSettings, slot: number | undefined): TerminalLook {
  return {
    appearance: settings.appearance,
    kittyKeyboard: settings.terminal.kitty_keyboard,
    agentColor: slot === undefined ? undefined : agentColor(slot),
  };
}

export function TerminalPanel({
  panel,
  folder,
  workspaceName,
  tabName,
  focused,
  visible,
  settings,
  onChange,
  onFocus,
  alone,
  maximized,
  onLayout,
}: PanelViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const sticky = useRef<HTMLDivElement>(null);
  const stickyId = useRef<number | undefined>(undefined);
  const view = useRef<TerminalView | undefined>(undefined);
  const [listed, setListed] = useState<{ readonly id: string; readonly look: AgentLook }>();
  // The running agent (none once it ended: the panel is a plain shell again).
  const agentId = relaunches(panel) ? agentOf(panel)?.agent : undefined;
  const agent = listed !== undefined && listed.id === agentId ? listed.look : undefined;
  const slot = agent?.slot;
  const [finding, setFinding] = useState(false);
  const [results, setResults] = useState({ index: -1, count: 0 });
  const [findScope, setFindScope] = useState<string | undefined>(undefined);
  const [pendingPaste, setPendingPaste] = useState<{ text: string; paste: () => void }>();
  const [menu, setMenu] = useState<OpenMenu | undefined>(undefined);
  // N-03: the terminal's context menu: where, and whether text was selected then.
  const [context, setContext] = useState<{ at?: MenuPoint; selection: boolean }>();
  // Read when the shell is ready, not when the panel mounts (they may change meanwhile).
  const latest = useRef({
    panel,
    folder,
    workspaceName,
    tabName,
    settings,
    onChange,
    visible,
    focused,
    agent,
  });
  useEffect(() => {
    latest.current = {
      panel,
      folder,
      workspaceName,
      tabName,
      settings,
      onChange,
      visible,
      focused,
      agent,
    };
  });

  // The terminal is an external system: mounted once, disposed with the panel. Disposing only
  // detaches the view (StrictMode's second mount, a reload): the shell keeps running in the
  // core, and the next mount attaches to it with a replay instead of starting another.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const start = latest.current;
    const panelId = start.panel.id;
    // The folder the shell last reported (where an agent started now really runs).
    let reported: string | undefined;
    const agentRuns = () => relaunches(latest.current.panel);
    const looking = () => latest.current.focused && latest.current.visible && document.hasFocus();
    const mounted = mountTerminal(
      element,
      {
        panelId,
        profile: terminalOf(start.panel)?.profile ?? undefined,
        cwd: startFolder(start.panel) ?? undefined,
        visible: start.visible,
        agentPanel: agentRuns,
        imagePaste: () => latest.current.agent?.imagePaste,
        folder: () => reported ?? panelFolder(latest.current.panel) ?? undefined,
      },
      lookOf(start.settings, start.agent?.slot),
      {
        onTitle: (title) => {
          setTitle(panelId, title);
        },
        onCwd: (cwd) => {
          reported = cwd;
          latest.current.onChange(panelId, (p) => withCwd(p, cwd));
        },
        onReady: ({ profileId }) => {
          const now = latest.current;
          const ref = agentOf(now.panel);
          if (ref === undefined || !relaunches(now.panel)) return;
          const fresh = freshAgents.delete(panelId);
          let how: AgentStart;
          if (fresh) {
            how = { kind: "new", session: ref.session ?? null };
          } else {
            const restored = restoreStart(now.panel, continuing);
            if (restored.claims !== undefined) continuing.add(restored.claims);
            how = restored.start;
          }
          // The agent keeps its sessions in the folder it starts in: remember that one.
          const at = reported ?? startFolder(now.panel);
          if (at != null && (fresh || ref.cwd == null) && at !== ref.cwd) {
            now.onChange(panelId, (p) => withAgent(p, { cwd: at }));
          }
          void agentCommand(
            ref.agent,
            how,
            // N-06: the shell that really runs (the panel's profile may be gone).
            profileId,
            remoteControlName(now.settings.agents, now.folder, now.workspaceName, now.tabName),
          ).then(
            (line) => {
              mounted.startAgent(`${line}\r`, ref.agent);
            },
            (error: unknown) => {
              console.warn("could not start the agent", error);
            },
          );
        },
        onAgentExit: () => {
          latest.current.onChange(panelId, (p) => withAgent(p, { running: false }));
        },
        onAgentWorking: () => {
          agentWorking(panelId);
        },
        onExit: () => undefined,
        onCommand: (runs) => {
          commandRunning(panelId, runs);
        },
        onAttention: (message) => {
          requestAttention(panelId, message, looking());
        },
        onProgress: (progress) => {
          setProgress(panelId, progress);
        },
        onFind: () => {
          // Ctrl+Shift+F searches everything again (a command's scope ends).
          mounted.scopeFind(undefined);
          setFindScope(undefined);
          setResults({ index: -1, count: 0 });
          setFinding(true);
        },
        onFindResults: (index, count) => {
          // N-02: the search refires its results after output while a match is highlighted:
          // the same values change nothing (no render per output burst).
          setResults((now) =>
            now.index === index && now.count === count ? now : { index, count },
          );
        },
        onConfirmPaste: (text, paste) => {
          setPendingPaste({ text, paste });
        },
        onMarkMenu: (info, at) => {
          const frame = box.current?.getBoundingClientRect();
          if (frame === undefined) return;
          setMenu({
            info,
            actions: markActions(info, {
              idlePrompt: mounted.idlePrompt(),
              hasOutput: mounted.hasOutput(info.id),
            }),
            left: at.left - frame.left,
            top: at.bottom - frame.top,
          });
        },
        onContextMenu: (at) => {
          setContext({ at, selection: mounted.hasSelection() });
        },
        onSticky: (info) => {
          stickyId.current = info?.id;
          if (sticky.current !== null) paintSticky(sticky.current, info);
        },
      },
    );
    view.current = mounted;
    // Files dropped here are typed at the prompt, quoted for the shell that runs.
    setDropHandler(panelId, (paths) => {
      const profile = mounted.profileId();
      if (profile === undefined) return;
      const text = dropText(paths, dropTarget(profile, agentRuns()));
      if (text !== "") mounted.paste(text);
    });
    // N-01: the theme changed (`data-theme` on <html>: the setting, or the system under Auto):
    // the token colors changed.
    const restyle = () => {
      mounted.setLook(lookOf(latest.current.settings, latest.current.agent?.slot));
    };
    const themeWatch = new MutationObserver(restyle);
    themeWatch.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => {
      themeWatch.disconnect();
      setDropHandler(panelId, undefined);
      commandRunning(panelId, false);
      setProgress(panelId, undefined);
      clearAttention(panelId);
      mounted.dispose();
      view.current = undefined;
    };
  }, []);

  // The running agent's color and image-paste key (the agent list is read once per run).
  useEffect(() => {
    if (agentId === undefined) return;
    let live = true;
    void listAgents().then(
      (list) => {
        const info = list.find((a) => a.id === agentId);
        if (live && info !== undefined) {
          setListed({
            id: agentId,
            look: { slot: info.color, imagePaste: info.imagePaste ?? undefined },
          });
        }
      },
      (error: unknown) => {
        console.warn("could not list the agents", error);
      },
    );
    return () => {
      live = false;
    };
  }, [agentId]);

  // The look follows the settings and the agent's color live.
  useEffect(() => {
    view.current?.setLook(lookOf(settings, slot));
  }, [settings, slot]);

  // N-03: before the frame that shows (or hides) the panel is painted, so a terminal coming back
  // is drawn in its first frame (a passive effect can run a frame later).
  useLayoutEffect(() => {
    view.current?.setVisible(visible);
  }, [visible]);

  // The focused panel of the shown workspace has the keyboard (not while its find bar, paste
  // question or command menu does).
  const busy =
    finding || pendingPaste !== undefined || menu !== undefined || context?.at !== undefined;
  useEffect(() => {
    if (focused && !busy) view.current?.focus();
  }, [focused, busy]);

  // Looking at the panel (focused, shown, the window in front) clears its attention mark.
  useEffect(() => {
    if (!focused || !visible) return;
    const seen = () => {
      clearAttention(panel.id);
    };
    if (document.hasFocus()) seen();
    window.addEventListener("focus", seen);
    return () => {
      window.removeEventListener("focus", seen);
    };
  }, [focused, visible, panel.id]);

  const closeFind = () => {
    view.current?.clearFind();
    setFinding(false);
    setFindScope(undefined);
    view.current?.focus();
  };
  const runMarkAction = (action: MarkAction, info: MarkInfo) => {
    const current = view.current;
    if (current === undefined) return;
    switch (action) {
      case "copyCommand":
      case "copyOutput": {
        const text = current.commandText(info.id, action === "copyCommand" ? "command" : "output");
        if (text !== undefined && text !== "") void navigator.clipboard.writeText(text);
        current.focus();
        return;
      }
      case "selectOutput":
        current.selectOutput(info.id);
        return;
      case "rerun":
        current.rerun(info.id);
        return;
      case "find":
        current.scopeFind(info.id);
        setFindScope(commandSummary(info.command) || "a command");
        setResults({ index: -1, count: 0 });
        setFinding(true);
        return;
      case "notify":
        current.notifyWhenDone(info.id);
        return;
    }
  };

  const runContextAction = (action: TerminalMenuAction) => {
    const current = view.current;
    if (current === undefined) return;
    switch (action) {
      case "copy":
        current.copySelection();
        return;
      case "paste":
        current.pasteClipboard();
        return;
      case "selectAll":
        current.selectAll();
        return;
      case "clear":
        current.clear();
        return;
      case "find":
        current.scopeFind(undefined);
        setFindScope(undefined);
        setResults({ index: -1, count: 0 });
        setFinding(true);
        return;
      case "splitRight":
      case "splitDown":
      case "maximize":
        onLayout(panel.id, action);
        return;
    }
  };

  // N-01: an agent panel's background, mixed by CSS from the tokens, so a theme change restyles it
  // with the terminal (the same mix as `readTheme`'s for xterm's canvas).
  const swatch = slot === undefined ? undefined : `var(--wc-workspace-${String(slot)})`;
  const background =
    swatch === undefined
      ? undefined
      : `color-mix(in srgb, var(--wc-term-bg), ${swatch} calc(var(--wc-agent-tint) * 100%))`;
  // No padding on the right: xterm's scrollbar track (and the command marks' ruler on it) sits
  // on the card's edge, and keeps the text clear of the edge by its own width.
  return (
    <div
      ref={box}
      data-wc-drop={panel.id}
      className="relative size-full bg-term-bg py-(--wc-term-pad-y) pl-(--wc-term-pad-x)"
      style={background === undefined ? undefined : { background }}
      onMouseDown={() => {
        onFocus(panel.id);
      }}
    >
      {swatch !== undefined && (
        // The agent's color as a thin line along the top, fading out.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background: `linear-gradient(to right, ${swatch}, transparent 70%)`,
            opacity: "var(--wc-agent-edge)",
          }}
        />
      )}
      <div ref={host} className="size-full" />
      <StickyHeader
        ref={sticky}
        onJump={() => {
          const id = stickyId.current;
          if (id !== undefined) view.current?.revealCommand(id);
        }}
      />
      {finding && (
        <FindBar
          results={results}
          scope={findScope}
          onFind={(query: string, options: FindOptions, backwards: boolean) => {
            view.current?.find(query, options, backwards);
          }}
          onClose={closeFind}
        />
      )}
      {pendingPaste !== undefined && (
        <PasteConfirm
          text={pendingPaste.text}
          onPaste={() => {
            pendingPaste.paste();
            setPendingPaste(undefined);
          }}
          onCancel={() => {
            setPendingPaste(undefined);
          }}
        />
      )}
      {menu !== undefined && (
        <MarkMenu
          info={menu.info}
          actions={menu.actions}
          left={menu.left}
          top={menu.top}
          onAction={(action) => {
            runMarkAction(action, menu.info);
          }}
          onClose={() => {
            setMenu(undefined);
          }}
          onFocusBack={() => {
            if (!finding) view.current?.focus();
          }}
        />
      )}
      <TerminalMenu
        at={context?.at}
        selection={context?.selection ?? false}
        alone={alone}
        maximized={maximized}
        onAction={runContextAction}
        onClose={() => {
          setContext((now) => (now === undefined ? now : { selection: now.selection }));
        }}
      />
    </div>
  );
}
