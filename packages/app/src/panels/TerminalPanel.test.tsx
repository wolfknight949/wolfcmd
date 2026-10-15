// N-02: the terminal panel around its view. The xterm view is a stand-in (the real one needs a
// canvas); what is under test is the panel's own React state.
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Actions } from "../actions";
import { leaf } from "../model/layout";
import { terminalPanel } from "../model/panels";
import { complete } from "../store/settings";
import type { TerminalEvents } from "../terminal/terminal-view";
import { TerminalPanel } from "./TerminalPanel";

const view = vi.hoisted(() => ({ events: undefined as TerminalEvents | undefined }));
vi.mock("../terminal/terminal-view", () => ({
  mountTerminal: (_host: HTMLElement, _start: unknown, _look: unknown, events: TerminalEvents) => {
    view.events = events;
    return new Proxy({}, { get: () => () => undefined });
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

describe("N-02 terminal panel", () => {
  it("n02_find_results_same: the same find results again render nothing", () => {
    const commits = vi.fn();
    root = createRoot(host);
    act(() => {
      root?.render(
        <Profiler id="panel" onRender={commits}>
          <TerminalPanel
            panel={leaf(terminalPanel("p1"))}
            folder={null}
            workspaceName="app"
            tabName="Tab 1"
            focused={false}
            visible
            settings={complete({})}
            alone
            maximized={false}
            actions={{} as Actions}
            onChange={() => undefined}
            onFocus={() => undefined}
            onLayout={() => undefined}
          />
        </Profiler>,
      );
    });
    const events = view.events;
    if (events === undefined) throw new Error("no view mounted");
    act(() => {
      events.onFindResults(0, 3);
    });
    // The search refires the same results after each output burst: no render (React may
    // render once more before it bails out for good).
    const after = commits.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      act(() => {
        events.onFindResults(0, 3);
      });
    }
    expect(commits.mock.calls.length).toBeLessThanOrEqual(after + 1);
    const settled = commits.mock.calls.length;
    act(() => {
      events.onFindResults(1, 3);
    });
    expect(commits.mock.calls.length).toBe(settled + 1);
  });
});
