// N-11: which closes ask first, and what they say. Closing a panel, a tab or a workspace asks
// only when something in it still runs: an agent (`AgentRef.running`, or working right now) or a
// command in a plain shell (shell integration's marks: a shell at its prompt is idle). Quitting
// asks only for agents (they resume at the next start, but whatever they were doing stops).
// Idle panels never ask. Pure: what runs comes in as functions.
import { agentOf } from "./panels";
import type { PanelLeaf } from "./layout";

/** What is being closed. `tabs`: several tabs at once (close others, close to the right). */
export type Closing = "panel" | "tab" | "tabs" | "workspace" | "quit";

/** What still runs in the panels being closed. */
export interface Running {
  /** The agents running (their registry IDs), one per panel. */
  readonly agents: readonly string[];
  /** Plain shells with a command running. */
  readonly commands: number;
}

/** Where the panels' activity is read from. */
export interface RunningProbe {
  /** N-06: the panel's agent works right now (the core's activity). */
  readonly working: (panelId: string) => boolean;
  /** N-02: the panel's shell runs a command (OSC 133). */
  readonly commandRuns: (panelId: string) => boolean;
}

/** What runs in `panels`: a panel's agent while it runs, else its shell's command. */
export function runningIn(panels: readonly PanelLeaf[], probe: RunningProbe): Running {
  const agents: string[] = [];
  let commands = 0;
  for (const panel of panels) {
    const agent = agentOf(panel);
    if (agent !== undefined && (agent.running !== false || probe.working(panel.id))) {
      agents.push(agent.agent);
    } else if (probe.commandRuns(panel.id)) {
      commands += 1;
    }
  }
  return { agents, commands };
}

/** The calm question a close asks. */
export interface CloseQuestion {
  readonly title: string;
  readonly message: string;
  /** The button that closes (danger style); Cancel is the other one, focused. */
  readonly confirm: "Close" | "Quit";
}

const TITLES: Readonly<Record<Exclude<Closing, "tabs">, string>> = {
  panel: "Close this panel?",
  tab: "Close this tab?",
  workspace: "Close this workspace?",
  quit: "Quit WolfCmd?",
};

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Aider". */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/**
 * The question closing `closing` with `running` in it asks (`count`: how many tabs for `tabs`),
 * or `undefined` when nothing runs there and it closes at once. `name` turns an agent's ID into
 * its name.
 */
export function closeQuestion(
  closing: Closing,
  running: Running,
  name: (agentId: string) => string,
  count = 1,
): CloseQuestion | undefined {
  const commands = closing === "quit" ? 0 : running.commands;
  const agents = running.agents.length;
  if (agents === 0 && commands === 0) return undefined;
  const names = [...new Set(running.agents.map(name))];
  const parts: string[] = [];
  if (agents === 1) parts.push(names[0] ?? "");
  else if (agents > 1) parts.push(`${String(agents)} agents (${listed(names)})`);
  if (commands === 1) parts.push(parts.length === 0 ? "A command" : "a command");
  else if (commands > 1) parts.push(`${String(commands)} commands`);
  const many = agents + commands > 1;
  const where = closing === "quit" ? "" : closing === "tabs" ? " in them" : " in it";
  const resumes = closing === "quit" ? (many ? "; they resume" : "; it resumes") : "";
  const message =
    `${parts.join(" and ")} ${many ? "are" : "is"} still running${where}` +
    (resumes === "" ? "." : `${resumes} at the next start.`);
  return {
    title: closing === "tabs" ? `Close ${String(count)} tabs?` : TITLES[closing],
    message,
    confirm: closing === "quit" ? "Quit" : "Close",
  };
}
