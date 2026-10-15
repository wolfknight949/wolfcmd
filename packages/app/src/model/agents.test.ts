import type { Document, TerminalContent } from "@wolfcmd/bindings";
import { describe, expect, it } from "vitest";

import { type AgentChange, relaunches, restoreStart, startFolder, withAgent } from "./agents";
import { changePanel } from "./document";
import { leaf, type PanelLeaf, panelsOf } from "./layout";
import { agentOf, panelFolder, terminalPanel, withCwd } from "./panels";

const ID = "3f2a1c9e-0b1d-4f6a-8c2e-9a7b5d4c3e21";

const panel = (id: string, extra: Omit<TerminalContent, "kind"> = {}): PanelLeaf =>
  leaf(terminalPanel(id, { cwd: "C:\\dev\\app\\src", ...extra }));

const changeAgent = (doc: Document, panelId: string, change: AgentChange) =>
  changePanel(doc, panelId, (p) => withAgent(p, change));

const docWith = (...panels: PanelLeaf[]): Document => ({
  version: 1,
  active: "w1",
  workspaces: [
    {
      id: "w1",
      name: "",
      folder: null,
      activeTab: "t1",
      tabs: [
        {
          id: "t1",
          name: "",
          focused: panels[0]?.id ?? null,
          layout:
            panels.length === 1
              ? (panels[0] ?? null)
              : {
                  kind: "split",
                  id: "s1",
                  direction: "row",
                  children: panels,
                  ratios: panels.map(() => 1 / panels.length),
                },
        },
      ],
    },
  ],
});

const panelIn = (doc: Document, id: string) =>
  doc.workspaces
    .flatMap((w) => w.tabs)
    .flatMap((t) => (t.layout == null ? [] : panelsOf(t.layout)))
    .find((p) => p.id === id);

describe("N-06 agent panels across restarts", () => {
  it("a restored agent's shell starts in the agent's folder, an exited one where the shell was", () => {
    const running = panel("p1", {
      agent: { agent: "claude-code", session: ID, cwd: "C:\\dev\\app" },
    });
    expect(relaunches(running)).toBe(true);
    expect(startFolder(running)).toBe("C:\\dev\\app");
    // Files without `running` (or `cwd`) are agents still at work in the panel's folder.
    const old = panel("p2", { agent: { agent: "claude-code", session: ID } });
    expect(relaunches(old)).toBe(true);
    expect(startFolder(old)).toBe("C:\\dev\\app\\src");
    const exited = panel("p3", {
      agent: { agent: "claude-code", session: ID, cwd: "C:\\dev\\app", running: false },
    });
    expect(relaunches(exited)).toBe(false);
    expect(startFolder(exited)).toBe("C:\\dev\\app\\src");
    expect(relaunches(panel("p4"))).toBe(false);
    expect(startFolder(panel("p4", { cwd: null }))).toBe(null);
  });

  it("an agent that ended is marked once; the same change again keeps the document", () => {
    const doc = docWith(panel("p1", { agent: { agent: "codex", session: null, running: true } }));
    const stopped = changeAgent(doc, "p1", { running: false });
    const p1 = panelIn(stopped, "p1");
    expect(p1 === undefined ? undefined : agentOf(p1)?.running).toBe(false);
    expect(changeAgent(stopped, "p1", { running: false })).toBe(stopped);
    // A panel without an agent is left alone.
    const plain = docWith(panel("p1"));
    expect(changeAgent(plain, "p1", { running: false })).toBe(plain);
  });

  it("two restored Codex panels in one folder: the first continues, the second picks", () => {
    const codex = (id: string, cwd: string) =>
      panel(id, { agent: { agent: "codex", session: null, cwd, running: true } });
    const continuing = new Set<string>();
    const first = restoreStart(codex("p1", "C:\\dev\\app"), continuing);
    expect(first.start).toEqual({ kind: "resume", session: null });
    if (first.claims !== undefined) continuing.add(first.claims);
    // Same folder, written differently.
    const second = restoreStart(codex("p2", "c:/DEV/app/"), continuing);
    expect(second).toEqual({ start: { kind: "pick" }, claims: undefined });
    // Another folder, or another agent, continues its own latest session.
    expect(restoreStart(codex("p3", "C:\\dev\\other"), continuing).start.kind).toBe("resume");
    const aider = panel("p4", { agent: { agent: "aider", session: null, cwd: "C:\\dev\\app" } });
    expect(restoreStart(aider, continuing).start.kind).toBe("resume");
    // A panel with its own session always resumes it, and claims nothing.
    const claude = panel("p5", { agent: { agent: "codex", session: ID, cwd: "C:\\dev\\app" } });
    expect(restoreStart(claude, continuing)).toEqual({
      start: { kind: "resume", session: ID },
      claims: undefined,
    });
  });
});

describe("N-03 panel changes", () => {
  it("a folder report of the folder the panel is in keeps the document", () => {
    const doc = docWith(panel("p1"), panel("p2"));
    const same = changePanel(doc, "p1", (p) => withCwd(p, "C:\\dev\\app\\src"));
    expect(same).toBe(doc);
    const moved = changePanel(doc, "p1", (p) => withCwd(p, "C:\\dev"));
    expect(moved).not.toBe(doc);
    const p1 = panelIn(moved, "p1");
    expect(p1 === undefined ? undefined : panelFolder(p1)).toBe("C:\\dev");
    // The other panel is the very same object (its card does not re-render).
    expect(panelIn(moved, "p2")).toBe(panelIn(doc, "p2"));
    expect(changePanel(doc, "gone", (p) => withCwd(p, "x"))).toBe(doc);
  });
});
