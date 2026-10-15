// N-06: the + button opens the Add flyout and a choice adds that panel.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Actions } from "../actions";
import { catalog } from "../store/catalog";
import { createAddRegistry, TERMINAL_ENTRY } from "./add-entries";
import { addBarItem } from "./AddMenu";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  catalog.setState({
    profiles: [
      { id: "pwsh", name: "PowerShell", icon: "terminal", isDefault: true },
      { id: "cmd", name: "Command Prompt", icon: "terminal", isDefault: false },
    ],
    agents: [],
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  catalog.setState({ profiles: [], agents: [], problems: [] });
});

describe("N-06 the Add flyout", () => {
  it("n06_add_flyout: + opens the entries; Command Prompt opens a terminal with that shell", () => {
    const entries = createAddRegistry();
    entries.register(TERMINAL_ENTRY);
    const { Component } = addBarItem(entries);
    const newTerminal = vi.fn();
    root = createRoot(host);
    act(() => {
      root?.render(<Component actions={{ newTerminal } as unknown as Actions} />);
    });
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Add"]');
    if (button === null) throw new Error("no Add button");
    act(() => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("Add a panel");
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Terminal"),
      expect.stringContaining("PowerShell"),
      expect.stringContaining("Command Prompt"),
    ]);
    act(() => {
      items[2]?.click();
    });
    expect(newTerminal).toHaveBeenCalledWith(undefined, "cmd");
  });
});
