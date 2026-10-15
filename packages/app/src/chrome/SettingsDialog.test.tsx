// N-07: the Settings dialog: every control changes the settings store at once (and saves), the
// bar button opens it and Esc closes it.
import type { Settings } from "@wolfcmd/bindings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Actions } from "../actions";
import { catalog } from "../store/catalog";
import { complete, createSettingsStore, type SettingsStore } from "../store/settings";
import type { Measure } from "./fonts";
import { settingsBarItem } from "./SettingsButton";
import { SettingsDialog } from "./SettingsDialog";
import { closeSettings, settingsOpen } from "./settings-open";

const listProfiles = vi.hoisted(() => vi.fn());
const openDataFolder = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../core/profiles", () => ({ listProfiles }));
vi.mock("../core/about", () => ({
  aboutApp: () =>
    Promise.resolve({ version: "0.5.0", commit: "abc1234", dataFolder: String.raw`C:\data` }),
  openDataFolder,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PROFILES = [
  { id: "pwsh", name: "PowerShell", icon: "terminal", isDefault: true },
  { id: "cmd", name: "Command Prompt", icon: "terminal", isDefault: false },
];

/** Consolas is installed (and monospaced); every other family measures like the fallback. */
const measure: Measure = (font, text) => (font.includes('"Consolas"') ? 10 : 9) * text.length;

let root: Root;
let host: HTMLDivElement;
let settings: SettingsStore;
let save: ReturnType<typeof vi.fn<(s: Settings) => Promise<unknown>>>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  save = vi.fn<(s: Settings) => Promise<unknown>>(() => Promise.resolve());
  settings = createSettingsStore(complete({}), save);
  catalog.setState({ profiles: PROFILES });
  listProfiles.mockResolvedValue(PROFILES);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  closeSettings();
  catalog.setState({ profiles: [], agents: [], problems: [] });
});

async function show() {
  await act(async () => {
    root.render(<SettingsDialog settings={settings} onClose={vi.fn()} measure={measure} />);
    await Promise.resolve();
  });
}

/** The row named `title` (its first line). */
function row(title: string): HTMLElement {
  const label = [...document.querySelectorAll("span")].find((s) => s.textContent === title);
  const card = label?.parentElement?.parentElement;
  if (!card) throw new Error(`no row ${title}`);
  return card;
}

const click = (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) throw new Error("nothing to click");
  act(() => {
    element.click();
  });
};

const radio = (title: string, label: string) =>
  [...row(title).querySelectorAll("label")]
    .find((l) => l.textContent === label)
    ?.querySelector("input");

function typeInto(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  act(() => {
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const key = (target: Element, name: string) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
};

/** Opens the Radix menu behind `trigger` and picks the item named `label`. */
function pick(trigger: Element | null, label: string) {
  if (!(trigger instanceof HTMLElement)) throw new Error("no menu trigger");
  key(trigger, "Enter");
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (i) => i.textContent === label,
  );
  click(item);
}

describe("N-07 Settings dialog", () => {
  it("n07_settings_appearance: theme, font, size, cursor and smooth scrolling apply at once", async () => {
    await show();
    // The chosen theme has the focus (the dialog's first control).
    expect(document.activeElement).toBe(radio("Theme", "Dark Modern"));
    click(radio("Theme", "Light"));
    expect(settings.getState().appearance.theme).toBe("light");
    click(radio("Theme", "Auto"));
    expect(settings.getState().appearance.theme).toBe("auto");

    const font = row("Font").querySelector("input");
    if (font === null) throw new Error("no font field");
    typeInto(font, "Nope Mono");
    expect(row("Font").textContent).toContain("Not installed");
    // Typing alone doesn't restyle every terminal; Enter applies it.
    expect(settings.getState().appearance.font_family).toBe("");
    key(font, "Enter");
    expect(settings.getState().appearance.font_family).toBe("Nope Mono");
    // An installed family typed in full applies at once.
    typeInto(font, "Consolas");
    expect(settings.getState().appearance.font_family).toBe("Consolas");
    pick(row("Font").querySelector("button"), "Default (Cascadia Mono)");
    expect(settings.getState().appearance.font_family).toBe("");

    click(row("Font size").querySelector('button[aria-label="Larger"]'));
    expect(settings.getState().appearance.font_size).toBe(15);
    const size = row("Font size").querySelector<HTMLInputElement>('[role="spinbutton"]');
    if (size === null) throw new Error("no size box");
    key(size, "ArrowDown");
    key(size, "ArrowDown");
    expect(settings.getState().appearance.font_size).toBe(13);
    // A shortcut's change (Ctrl+=) shows in the box.
    act(() => {
      settings.apply((s) => ({ ...s, appearance: { ...s.appearance, font_size: 20 } }));
    });
    expect(size.value).toBe("20");

    click(radio("Cursor", "Block"));
    expect(settings.getState().appearance.cursor).toBe("block");
    click(row("Smooth scrolling").querySelector('[role="switch"]'));
    expect(settings.getState().appearance.smooth_scroll).toBe(false);
    // N-06: the finish glow (on by default) turns off.
    const glow = row("Glow the panel when an agent finishes").querySelector('[role="switch"]');
    expect(glow?.getAttribute("aria-checked")).toBe("true");
    click(glow);
    expect(settings.getState().appearance.finish_glow).toBe(false);

    await settings.saved();
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appearance: {
          theme: "auto",
          font_family: "",
          font_size: 20,
          cursor: "block",
          smooth_scroll: false,
          finish_glow: false,
        },
      }),
    );
  });

  it("n07_settings_terminal_and_agents: default shell, Kitty, Remote Control, notifications", async () => {
    await show();
    expect(row("Default shell").textContent).toContain("New terminals run PowerShell");
    listProfiles.mockResolvedValue(PROFILES.map((p) => ({ ...p, isDefault: p.id === "cmd" })));
    pick(row("Default shell").querySelector("button"), "Command Prompt");
    expect(settings.getState().terminal.default_profile).toBe("cmd");
    // Once saved, the profiles are read again: the core now marks Command Prompt.
    await act(async () => {
      await settings.saved();
      await Promise.resolve();
    });
    expect(listProfiles).toHaveBeenCalled();
    expect(row("Default shell").textContent).toContain("New terminals run Command Prompt");
    pick(row("Default shell").querySelector("button"), "Automatic");
    expect(settings.getState().terminal.default_profile).toBe("");

    click(row("Kitty keyboard protocol").querySelector('[role="switch"]'));
    expect(settings.getState().terminal.kitty_keyboard).toBe(true);
    click(row("Remote Control").querySelector('[role="switch"]'));
    expect(settings.getState().agents.remote_control).toBe(true);
    click(row("Notify when an agent finishes").querySelector('[role="switch"]'));
    expect(settings.getState().agents.notify_when_done).toBe(false);
  });

  it("n01_settings_window: closing keeps WolfCmd in the tray until turned off", async () => {
    await show();
    const tray = row("Keep running in the tray when closed");
    expect(tray.textContent).toContain("Ctrl+Q");
    const toggle = tray.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    click(toggle);
    expect(settings.getState().window.close_to_tray).toBe(false);
  });

  it("n07_settings_about: the version, the data folder and Open", async () => {
    await show();
    expect(row("WolfCmd").textContent).toContain("Version 0.5.0 (abc1234)");
    expect(row("Data folder").textContent).toContain(String.raw`C:\data`);
    click(row("Data folder").querySelector("button"));
    expect(openDataFolder).toHaveBeenCalledOnce();
  });

  it("n07_settings_button: the bar button opens it, Esc closes it and the focus comes back", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { Component, placement } = settingsBarItem(settings);
    expect(placement).toBe("bottom");
    await act(async () => {
      root.render(<Component actions={{} as Actions} />);
      await Promise.resolve();
    });
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
    if (button === null) throw new Error("no Settings button");
    button.focus();
    click(button);
    expect(settingsOpen.getState().open).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Appearance");
    expect(button.dataset.state).toBe("open");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(settingsOpen.getState().open).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
