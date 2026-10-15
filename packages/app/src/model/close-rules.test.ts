import { describe, expect, it } from "vitest";

import { closeQuestion, runningIn, type RunningProbe } from "./close-rules";
import { leaf } from "./layout";
import { terminalPanel } from "./panels";

const shell = (id: string) => leaf(terminalPanel(id));
const agentPanel = (id: string, agent: string, running: boolean) =>
  leaf(terminalPanel(id, { agent: { agent, session: null, cwd: null, running } }));

const NAMES: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex" };
const name = (id: string) => NAMES[id] ?? id;

const probe = (busy: readonly string[] = [], working: readonly string[] = []): RunningProbe => ({
  commandRuns: (id) => busy.includes(id),
  working: (id) => working.includes(id),
});

describe("N-11 which closes ask", () => {
  it("n11_close_rules: idle shells and ended agents close at once", () => {
    const panels = [shell("a"), agentPanel("b", "claude-code", false)];
    expect(closeQuestion("panel", runningIn(panels, probe()), name)).toBeUndefined();
    expect(closeQuestion("workspace", runningIn(panels, probe()), name)).toBeUndefined();
    expect(closeQuestion("quit", runningIn(panels, probe()), name)).toBeUndefined();
  });

  it("n11_close_rules: a running agent asks, by name", () => {
    const panels = [agentPanel("a", "claude-code", true)];
    expect(closeQuestion("panel", runningIn(panels, probe()), name)).toEqual({
      title: "Close this panel?",
      message: "Claude Code is still running in it.",
      confirm: "Close",
    });
  });

  it("n11_close_rules: an agent still working asks even after it was marked ended", () => {
    const panels = [agentPanel("a", "claude-code", false)];
    expect(closeQuestion("panel", runningIn(panels, probe([], ["a"])), name)?.message).toBe(
      "Claude Code is still running in it.",
    );
  });

  it("n11_close_rules: a tab or workspace says how many agents", () => {
    const panels = [
      agentPanel("a", "claude-code", true),
      agentPanel("b", "codex", true),
      agentPanel("c", "claude-code", true),
      shell("d"),
    ];
    const asked = closeQuestion("workspace", runningIn(panels, probe()), name);
    expect(asked?.title).toBe("Close this workspace?");
    expect(asked?.message).toBe("3 agents (Claude Code and Codex) are still running in it.");
    const tabs = closeQuestion("tabs", runningIn(panels, probe(["d"])), name, 2);
    expect(tabs?.title).toBe("Close 2 tabs?");
    expect(tabs?.message).toBe(
      "3 agents (Claude Code and Codex) and a command are still running in them.",
    );
  });

  it("n11_close_rules: a running command in a plain shell asks; quitting doesn't for it", () => {
    const panels = [shell("a"), shell("b")];
    expect(closeQuestion("tab", runningIn(panels, probe(["a"])), name)).toEqual({
      title: "Close this tab?",
      message: "A command is still running in it.",
      confirm: "Close",
    });
    expect(closeQuestion("tab", runningIn(panels, probe(["a", "b"])), name)?.message).toBe(
      "2 commands are still running in it.",
    );
    expect(closeQuestion("quit", runningIn(panels, probe(["a"])), name)).toBeUndefined();
  });

  it("n11_close_rules: quitting with a running agent asks once and says it resumes", () => {
    const panels = [agentPanel("a", "claude-code", true), agentPanel("b", "codex", true)];
    expect(closeQuestion("quit", runningIn(panels, probe()), name)).toEqual({
      title: "Quit WolfCmd?",
      message: "2 agents (Claude Code and Codex) are still running; they resume at the next start.",
      confirm: "Quit",
    });
  });
});
