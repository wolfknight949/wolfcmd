// N-03: the terminal panel type, the one built in: a shell, maybe running an agent (N-06). Its
// header's title follows one rule (`model/panel-title.ts`); its icon is the terminal's, or the
// agent's in the agent's color; the folder is the one its shell last reported.
import { useStore } from "zustand";

import { TERMINAL_ENTRY } from "../chrome/add-entries";
import { panelTitle } from "../model/panel-title";
import { agentOf, TERMINAL_KIND, terminalOf } from "../model/panels";
import { catalog, profileName } from "../store/catalog";
import { titles } from "../store/titles";
import { PanelHeader } from "./PanelHeader";
import { TerminalPanel } from "./TerminalPanel";
import type { PanelHeaderProps, PanelType } from "./types";

function TerminalHeader(props: PanelHeaderProps) {
  const { panel } = props;
  const terminal = terminalOf(panel);
  const agentRef = agentOf(panel);
  const live = useStore(titles, (all) => all[panel.id]);
  const shell = useStore(catalog, (c) => profileName(c.profiles, terminal?.profile));
  const agent = useStore(catalog, (c) =>
    agentRef === undefined ? undefined : c.agents.find((a) => a.id === agentRef.agent),
  );
  const look = {
    title: panelTitle({ title: panel.title, agent: agentRef }, live, shell, agent?.name),
    icon: agentRef === undefined ? "terminal" : "agent",
    color: agent && `var(--wc-workspace-${String(agent.color)})`,
    cwd: terminal?.cwd,
  } as const;
  return <PanelHeader {...props} look={look} />;
}

export const TERMINAL_TYPE: PanelType = {
  id: "wolfcmd.terminal",
  order: 0,
  kind: TERMINAL_KIND,
  label: "Terminal",
  View: TerminalPanel,
  Header: TerminalHeader,
  add: TERMINAL_ENTRY,
};
