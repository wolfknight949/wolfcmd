import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Menu } from "./Menu";

afterEach(cleanup);

/** Radix opens on pointerdown (mouse) or Enter/Space/ArrowDown (keyboard). */
function open(button: HTMLElement) {
  act(() => {
    fireEvent.keyDown(button, { key: "Enter" });
  });
}

describe("flyout menu", () => {
  it("lists items with their hints and runs the chosen one", () => {
    const pwsh = vi.fn();
    const cmd = vi.fn();
    render(
      <Menu
        trigger={
          <button type="button" aria-label="Profiles">
            open
          </button>
        }
        sections={[
          {
            label: "Shells",
            items: [
              {
                id: "pwsh",
                label: "PowerShell",
                icon: "terminal",
                hint: "Ctrl+Shift+1",
                onSelect: pwsh,
              },
              { id: "cmd", label: "Command Prompt", onSelect: cmd },
            ],
          },
        ]}
      />,
    );
    open(screen.getByRole("button", { name: "Profiles" }));
    const menu = screen.getByRole("menu", { name: "Profiles" });
    expect(menu.textContent).toContain("Ctrl+Shift+1");
    expect(menu.textContent).toContain("Shells");
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Command Prompt/ }));
    });
    expect(cmd).toHaveBeenCalledOnce();
    expect(pwsh).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a long menu scrolls inside the space the window leaves", () => {
    render(
      <Menu
        trigger={
          <button type="button" aria-label="Many">
            open
          </button>
        }
        sections={[
          {
            items: Array.from({ length: 40 }, (_, i) => ({
              id: `i${String(i)}`,
              label: `A long entry number ${String(i)}`,
              hint: "Ctrl+Alt+Shift+K",
              onSelect: vi.fn(),
            })),
          },
        ]}
      />,
    );
    open(screen.getByRole("button", { name: "Many" }));
    const menu = screen.getByRole("menu", { name: "Many" });
    expect(menu.className).toContain("max-h-(--radix-dropdown-menu-content-available-height)");
    expect(menu.className).toContain("overflow-y-auto");
    // A shortcut hint never wraps or shrinks; the label gives way (ellipsis + tooltip).
    const hint = screen.getAllByText("Ctrl+Alt+Shift+K")[0];
    expect(hint?.className).toContain("shrink-0");
    expect(hint?.className).toContain("whitespace-nowrap");
  });

  it("N-01 uses the menu surface and item metrics", () => {
    render(
      <Menu
        trigger={
          <button type="button" aria-label="Actions">
            open
          </button>
        }
        sections={[
          { items: [{ id: "a", label: "Alpha", onSelect: vi.fn() }] },
          { items: [{ id: "b", label: "Beta", onSelect: vi.fn() }] },
        ]}
      />,
    );
    open(screen.getByRole("button", { name: "Actions" }));
    const menu = screen.getByRole("menu", { name: "Actions" });
    expect(menu.className).toContain("wc-menu");
    expect(menu.className).toContain("wc-flyout");
    expect(screen.getByRole("menuitem", { name: "Alpha" }).className).toContain("wc-menu-item");
    expect(screen.getByRole("separator").className).toContain("wc-menu-separator");
    // No item has an icon or a mark, so there is no empty icon column.
    expect(menu.querySelector(".wc-menu-icon")).toBeNull();
  });

  it("keys: arrows wrap, Home/End, type-ahead, disabled items skipped", async () => {
    const run = vi.fn();
    render(
      <Menu
        trigger={
          <button type="button" aria-label="Keys">
            open
          </button>
        }
        sections={[
          {
            items: [
              { id: "copy", label: "Copy", icon: "copy", onSelect: vi.fn() },
              { id: "paste", label: "Paste", disabled: true, onSelect: vi.fn() },
              { id: "rename", label: "Rename", onSelect: run },
            ],
          },
        ]}
      />,
    );
    open(screen.getByRole("button", { name: "Keys" }));
    const menu = screen.getByRole("menu", { name: "Keys" });
    const copy = screen.getByRole("menuitem", { name: "Copy" });
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    const paste = screen.getByRole("menuitem", { name: "Paste" });
    expect(paste.getAttribute("aria-disabled")).toBe("true");
    // Keys go to the focused item, or to the menu itself; Radix moves focus in a timeout.
    const press = (key: string) => {
      const focused = document.activeElement;
      act(() => {
        fireEvent.keyDown(focused && menu.contains(focused) ? focused : menu, { key });
      });
    };
    const focusOn = (item: HTMLElement) =>
      waitFor(() => {
        expect(document.activeElement).toBe(item);
      });
    press("End");
    await focusOn(rename);
    press("ArrowDown");
    await focusOn(copy);
    press("ArrowDown");
    await focusOn(rename);
    press("Home");
    await focusOn(copy);
    press("r");
    await focusOn(rename);
    press("Enter");
    expect(run).toHaveBeenCalledOnce();
  });

  it("toggles carry a check mark and choices a radio dot", () => {
    render(
      <Menu
        trigger={
          <button type="button" aria-label="View">
            open
          </button>
        }
        sections={[
          { items: [{ id: "wrap", label: "Word wrap", checked: true, onSelect: vi.fn() }] },
          {
            radio: true,
            items: [
              { id: "small", label: "Small", onSelect: vi.fn() },
              { id: "large", label: "Large", checked: true, onSelect: vi.fn() },
            ],
          },
        ]}
      />,
    );
    open(screen.getByRole("button", { name: "View" }));
    const wrap = screen.getByRole("menuitemcheckbox", { name: "Word wrap" });
    expect(wrap.getAttribute("aria-checked")).toBe("true");
    const large = screen.getByRole("menuitemradio", { name: "Large" });
    expect(large.getAttribute("aria-checked")).toBe("true");
    expect(large.querySelector(".wc-menu-radio")).not.toBeNull();
    const small = screen.getByRole("menuitemradio", { name: "Small" });
    expect(small.getAttribute("aria-checked")).toBe("false");
    expect(small.querySelector(".wc-menu-radio")).toBeNull();
  });

  it("N-10: an inset item is indented and shows its own tooltip", () => {
    render(
      <Menu
        trigger={
          <button type="button" aria-label="Repos">
            open
          </button>
        }
        sections={[
          {
            radio: true,
            items: [
              { id: "app", label: "app", checked: true, onSelect: vi.fn() },
              {
                id: "fix",
                label: "fix",
                inset: true,
                title: String.raw`C:\dev\app.worktrees\fix`,
                onSelect: vi.fn(),
              },
            ],
          },
        ]}
      />,
    );
    open(screen.getByRole("button", { name: "Repos" }));
    const app = screen.getByRole("menuitemradio", { name: "app" });
    const fix = screen.getByRole("menuitemradio", { name: "fix" });
    expect(app.className).not.toContain("wc-menu-item-inset");
    expect(fix.className).toContain("wc-menu-item-inset");
    expect(fix.querySelector("[title]")?.getAttribute("title")).toBe(
      String.raw`C:\dev\app.worktrees\fix`,
    );
  });

  it("N-06: what an item opened keeps the focus; Esc gives it back to the trigger", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    render(
      <Menu
        trigger={
          <button type="button" aria-label="Add">
            +
          </button>
        }
        sections={[
          {
            items: [
              {
                id: "open",
                label: "Open",
                onSelect: () => {
                  field.focus();
                },
              },
            ],
          },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Add" });
    open(trigger);
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(field);

    // Opened from the trigger with the keyboard: Esc gives it back to the trigger.
    trigger.focus();
    open(trigger);
    act(() => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
    field.remove();
  });

  /** A menu over a "terminal" (a focused text area), opened with the mouse. */
  function overTerminal(onSelect: () => void = () => undefined) {
    const terminal = document.createElement("textarea");
    terminal.setAttribute("aria-label", "Terminal");
    const other = document.createElement("textarea");
    other.setAttribute("aria-label", "Other terminal");
    document.body.append(terminal, other);
    render(
      <Menu
        trigger={
          <button type="button" aria-label="Add">
            +
          </button>
        }
        sections={[{ items: [{ id: "copy", label: "Copy", onSelect }] }]}
      />,
    );
    terminal.focus();
    const trigger = screen.getByRole("button", { name: "Add" });
    // Radix opens on the press (and keeps the focus off the trigger); the click follows.
    act(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.mouseDown(trigger, { button: 0 });
    });
    return { terminal, other, trigger };
  }

  it("n02_menu_focus_return: Esc gives the keyboard back to the terminal it came from", async () => {
    const { terminal, other } = overTerminal();
    const menu = screen.getByRole("menu");
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });
    act(() => {
      fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    });
    // At once, as it starts closing: the next key reaches the terminal, not the fading menu.
    expect(document.activeElement).toBe(terminal);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(terminal);
    terminal.remove();
    other.remove();
  });

  it("n02_menu_focus_return: an item that opens nothing hands the keyboard back at once", async () => {
    const select = vi.fn();
    const { terminal, other } = overTerminal(select);
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    });
    expect(select).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(terminal);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(terminal);
    terminal.remove();
    other.remove();
  });

  it("n02_menu_focus_return: never takes the keyboard from a terminal clicked meanwhile", async () => {
    const { terminal, other, trigger } = overTerminal();
    await waitFor(() => {
      expect(screen.getByRole("menu").contains(document.activeElement)).toBe(true);
    });
    // The user clicks another terminal: the menu closes, that terminal keeps the keyboard.
    act(() => {
      fireEvent.pointerDown(other, { button: 0, pointerType: "mouse" });
      other.focus();
    });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(trigger);
    terminal.remove();
    other.remove();
  });

  it("n02_menu_focus_return: a click on the trigger never takes the keyboard", () => {
    const { terminal, other, trigger } = overTerminal();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    trigger.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    terminal.remove();
    other.remove();
  });
});
