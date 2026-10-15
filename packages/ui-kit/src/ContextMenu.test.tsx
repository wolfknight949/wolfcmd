// N-03: context menus at a point (a right-click, the keyboard's menu keys) and an item's own
// context menu inside a menu.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isContextMenuKey, isKeyboardMenu, openContextMenuFrom } from "./context-keys";
import { ContextMenu, Menu, type MenuPoint, menuPoint } from "./Menu";

afterEach(cleanup);

function Target({ onRename }: { readonly onRename: () => void }) {
  const [at, setAt] = useState<MenuPoint | undefined>(undefined);
  return (
    <>
      <textarea aria-label="Terminal" />
      <div
        data-testid="target"
        onContextMenu={(event) => {
          event.preventDefault();
          setAt(menuPoint(event));
        }}
      />
      <ContextMenu
        at={at}
        label="Tab actions"
        sections={[
          {
            items: [{ id: "rename", label: "Rename", hint: "Double-click", onSelect: onRename }],
          },
        ]}
        onClose={() => {
          setAt(undefined);
        }}
      />
    </>
  );
}

describe("N-03 context menu", () => {
  it("n03_context_menu: opens at the pointer, runs an item, closes", () => {
    const rename = vi.fn();
    render(<Target onRename={rename} />);
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => {
      fireEvent.contextMenu(screen.getByTestId("target"), { clientX: 120, clientY: 40 });
    });
    const menu = screen.getByRole("menu", { name: "Tab actions" });
    expect(menu.className).toContain("wc-flyout");
    expect(menu.textContent).toContain("Double-click");
    const anchor = screen.getByRole("button", { name: "Tab actions", hidden: true });
    expect(anchor.style.left).toBe("120px");
    expect(anchor.style.top).toBe("40px");
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    });
    expect(rename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("n03_context_menu_focus: Esc gives the focus back to what had it, never the anchor", async () => {
    render(<Target onRename={() => undefined} />);
    const terminal = screen.getByRole("textbox", { name: "Terminal" });
    terminal.focus();
    act(() => {
      fireEvent.contextMenu(screen.getByTestId("target"), { clientX: 10, clientY: 10 });
    });
    const menu = screen.getByRole("menu");
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });
    act(() => {
      fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(terminal);
    });
  });

  it("n03_keyboard_menu: Shift+F10 and the Menu key; the keyboard's event is marked", () => {
    const key = (key: string, shiftKey = false, ctrlKey = false) => ({
      type: "keydown",
      key,
      shiftKey,
      ctrlKey,
      altKey: false,
      metaKey: false,
    });
    expect(isContextMenuKey(key("F10", true))).toBe(true);
    expect(isContextMenuKey(key("ContextMenu"))).toBe(true);
    expect(isContextMenuKey(key("F10"))).toBe(false);
    expect(isContextMenuKey(key("F10", true, true))).toBe(false);

    const target = document.createElement("div");
    document.body.append(target);
    const seen: boolean[] = [];
    target.addEventListener("contextmenu", (event) => {
      seen.push(isKeyboardMenu(event));
      event.preventDefault();
    });
    expect(openContextMenuFrom(target)).toBe(true);
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(seen).toEqual([true, false]);
    target.remove();
  });

  it("n03_item_context_menu: a row's own menu opens over its menu, which stays open", () => {
    const close = vi.fn();
    const open = vi.fn();
    render(
      <Menu
        trigger={
          <button type="button" aria-label="Workspaces">
            open
          </button>
        }
        sections={[
          {
            items: [
              {
                id: "w1",
                label: "App",
                onSelect: open,
                contextMenu: {
                  label: "Workspace actions",
                  sections: [
                    { items: [{ id: "close", label: "Close workspace", onSelect: close }] },
                  ],
                },
              },
            ],
          },
        ]}
      />,
    );
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Workspaces" }), { key: "Enter" });
    });
    act(() => {
      fireEvent.contextMenu(screen.getByRole("menuitem", { name: "App" }), {
        clientX: 30,
        clientY: 30,
      });
    });
    expect(screen.getByRole("menu", { name: "Workspace actions" })).toBeTruthy();
    expect(screen.getByRole("menu", { name: "Workspaces" })).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Close workspace" }));
    });
    expect(close).toHaveBeenCalledOnce();
    // The row itself was not chosen.
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "Workspace actions" })).toBeNull();
  });
});
