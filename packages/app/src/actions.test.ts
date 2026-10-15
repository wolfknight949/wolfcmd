import type { Document } from "@wolfcmd/bindings";
import { describe, expect, it, vi } from "vitest";

import { type CloseAsking, createActions } from "./actions";
import type { CloseAnswer } from "./chrome/close-question";
import type { CloseQuestion } from "./model/close-rules";
import {
  activeTab,
  activeWorkspace,
  addTab,
  emptyDocument,
  openPanel,
  workspacePanels,
} from "./model/document";
import { terminalPanel } from "./model/panels";
import { complete, createSettingsStore } from "./store/settings";
import { createWorkspaceStore } from "./store/workspaces";

const quitApp = vi.hoisted(() => vi.fn());
vi.mock("./core/window", () => ({ quitApp }));

const ids = () => {
  let n = 0;
  return () => `id${String((n += 1))}`;
};

/** A workspace with a shell `shell` and a running Claude Code panel `agent` in its first tab. */
function setup(answer: CloseAnswer = { close: false, dontAsk: false }, busy: string[] = []) {
  const newId = ids();
  let doc: Document = emptyDocument(newId);
  doc = openPanel(doc, terminalPanel("shell"), "right", newId);
  doc = openPanel(
    doc,
    terminalPanel("agent", {
      agent: { agent: "claude-code", session: "s1", cwd: null, running: true },
    }),
    "right",
    newId,
  );
  const store = createWorkspaceStore({ document: doc, readOnly: false }, vi.fn());
  const settings = createSettingsStore(complete({}), () => Promise.resolve({}));
  const questions: CloseQuestion[] = [];
  const asking: CloseAsking = {
    working: () => false,
    commandRuns: (id) => busy.includes(id),
    agentName: (id) => (id === "claude-code" ? "Claude Code" : id),
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(answer);
    },
  };
  const actions = createActions(store, settings, asking);
  const panels = () =>
    store
      .getState()
      .document.workspaces.flatMap(workspacePanels)
      .map((p) => p.id);
  return { store, settings, actions, questions, panels, newId };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("N-11 closing what runs asks first", () => {
  it("n11_confirm: an idle shell closes at once, without a question", () => {
    const { actions, questions, panels } = setup();
    actions.closePanel("shell");
    expect(questions).toEqual([]);
    expect(panels()).toEqual(["agent"]);
  });

  it("n11_confirm: a running agent asks; Cancel keeps the panel", async () => {
    const { actions, questions, panels } = setup({ close: false, dontAsk: false });
    actions.closePanel("agent");
    await settle();
    expect(questions[0]?.message).toBe("Claude Code is still running in it.");
    expect(panels()).toEqual(["shell", "agent"]);
  });

  it("n11_confirm: Close closes, and the close can be undone", async () => {
    const { store, actions, panels } = setup({ close: true, dontAsk: false });
    actions.closePanel("agent");
    await settle();
    expect(panels()).toEqual(["shell"]);
    expect(store.getState().undo).toBe("close panel");
    actions.undo();
    expect(panels()).toEqual(["shell", "agent"]);
  });

  it("n11_confirm: Don't ask again turns the question off for later closes", async () => {
    const { settings, actions, questions, panels, store, newId } = setup({
      close: true,
      dontAsk: true,
    });
    actions.closeTab(activeTab(activeWorkspace(store.getState().document))?.id ?? "");
    await settle();
    expect(questions[0]?.title).toBe("Close this tab?");
    expect(settings.getState().window.confirm_close).toBe(false);
    expect(panels()).toEqual([]);
    store.apply((d) =>
      openPanel(
        d,
        terminalPanel("again", {
          agent: { agent: "claude-code", session: "s2", cwd: null, running: true },
        }),
        "right",
        newId,
      ),
    );
    actions.closePanel("again");
    expect(questions).toHaveLength(1);
    expect(panels()).toEqual([]);
  });

  it("n11_confirm: a running command asks; close others counts the tabs", async () => {
    const { store, actions, questions, newId } = setup({ close: false, dontAsk: false }, ["shell"]);
    const first = activeTab(activeWorkspace(store.getState().document))?.id ?? "";
    store.apply((d) => addTab(d, newId));
    store.apply((d) => addTab(d, newId));
    const last = activeTab(activeWorkspace(store.getState().document))?.id ?? "";
    actions.closeOtherTabs(last);
    await settle();
    expect(questions[0]).toEqual({
      title: "Close 2 tabs?",
      message: "Claude Code and a command are still running in them.",
      confirm: "Close",
    });
    // Closing the empty tabs only asks nothing.
    actions.closeTabsToRight(first);
    expect(questions).toHaveLength(1);
    expect(activeWorkspace(store.getState().document)?.tabs).toHaveLength(1);
  });

  it("n11_confirm: quitting asks only while an agent runs", async () => {
    const asked = setup({ close: true, dontAsk: false });
    asked.actions.quit();
    await settle();
    await settle();
    expect(asked.questions[0]?.title).toBe("Quit WolfCmd?");
    expect(quitApp).toHaveBeenCalledOnce();

    const idle = setup({ close: true, dontAsk: false }, ["shell"]);
    idle.actions.closePanel("agent");
    await settle();
    idle.questions.length = 0;
    idle.actions.quit();
    await settle();
    expect(idle.questions).toEqual([]);
    expect(quitApp).toHaveBeenCalledTimes(2);
    expect(idle.panels()).toEqual(["shell"]);
  });
});
