// N-06: the Agents button (an item of the right bar) and the empty tab's agent buttons: each
// installed agent opens a terminal panel running it; a missing one says how to install it (never
// run by WolfCmd). Every agent shows its color. N-09: the menu reads the agents again when it
// opens, so a plugin added, changed or removed shows without a restart.
import type { AgentInfo } from "@wolfcmd/bindings";
import { Button, Menu } from "@wolfcmd/ui-kit";
import { useRef } from "react";
import { useStore } from "zustand";

import { pluginProblemsLine, reloadAgents } from "../core/agents";
import { catalog } from "../store/catalog";
import type { BarItem, BarItemProps } from "./bar";
import { focusShownTerminal } from "./focus";
import { BarButton } from "./RightBar";

/** The agents, as the core last found them (on PATH, where installers put them, plugins). */
const useAgents = (): readonly AgentInfo[] => useStore(catalog, (c) => c.agents);

/** An agent's color (`--wc-workspace-<n>`), for its dot. */
const agentSwatch = (agent: Pick<AgentInfo, "color">) =>
  `var(--wc-workspace-${String(agent.color)})`;

/**
 * N-09: where a plugin's agent comes from, shown beside its name (a plugin may name its agent like
 * a built-in one) and in its tooltip.
 */
const pluginNote = (agent: Pick<AgentInfo, "plugin">) =>
  agent.plugin === null ? {} : { hint: agent.plugin, title: `From the plugin ${agent.plugin}` };

/** N-09: reads the agents and plugin problems again into the catalog. */
function reload() {
  reloadAgents()
    .then(({ agents, problems }) => {
      catalog.setState({ agents, problems });
    })
    .catch((error: unknown) => {
      console.warn("could not list the agents", error);
    });
}

function AgentsBarButton({ actions }: BarItemProps) {
  const agents = useAgents();
  const problems = useStore(catalog, (c) => c.problems);
  const installed = agents.filter((a) => a.installed);
  const missing = agents.filter((a) => !a.installed);
  const trouble = pluginProblemsLine(problems);
  /** An agent was opened: its panel takes the keyboard when the menu has closed. */
  const opened = useRef(false);
  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) return;
        opened.current = false;
        reload();
      }}
      onCloseFocus={() => {
        const panel = opened.current;
        opened.current = false;
        return panel && focusShownTerminal();
      }}
      trigger={<BarButton icon="agent" label="Agents" />}
      side="left"
      align="start"
      sections={[
        {
          label: installed.length === 0 ? "No agent found" : "Open an agent",
          items: installed.map((agent) => ({
            id: agent.id,
            label: agent.name,
            swatch: agentSwatch(agent),
            ...pluginNote(agent),
            onSelect: () => {
              opened.current = true;
              actions.openAgent(agent);
            },
          })),
        },
        ...(missing.length === 0
          ? []
          : [
              {
                label: "Not installed (copy the install command)",
                items: missing.map((agent) => ({
                  id: agent.id,
                  label: agent.install ? `${agent.name}: ${agent.install}` : agent.name,
                  swatch: agentSwatch(agent),
                  ...pluginNote(agent),
                  disabled: !agent.install,
                  onSelect: () => {
                    if (agent.install) void navigator.clipboard.writeText(agent.install);
                  },
                })),
              },
            ]),
        // N-09: a calm line; the tooltip says what is wrong.
        ...(trouble === undefined
          ? []
          : [
              {
                items: [
                  {
                    id: "plugin-problems",
                    label: trouble.label,
                    title: trouble.details,
                    disabled: true,
                    onSelect: () => undefined,
                  },
                ],
              },
            ]),
      ]}
    />
  );
}

/** N-06: the right bar's built-in item. */
export const AGENTS_BAR_ITEM: BarItem = {
  id: "wolfcmd.agents",
  order: 100,
  Component: AgentsBarButton,
};

/** The installed agents as buttons (the empty tab). */
export function AgentChoices({ actions }: BarItemProps) {
  const installed = useAgents().filter((a) => a.installed);
  if (installed.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {installed.map((agent) => (
        <Button
          key={agent.id}
          {...(agent.plugin === null ? {} : { title: `From the plugin ${agent.plugin}` })}
          onClick={() => {
            actions.openAgent(agent);
          }}
        >
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: agentSwatch(agent) }}
          />
          {agent.name}
        </Button>
      ))}
    </div>
  );
}
