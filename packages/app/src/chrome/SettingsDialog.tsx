// N-07: Settings: one small dialog (ui-kit `Dialog`: the keyboard stays in it, Esc closes it,
// the focus goes back) with a few sections, each a quiet group of rows (N-01: thin dividers, no
// cards): a name and one line about it on the left, the control on the right. Every change applies at once and is
// saved through the settings store; there is only Close. Terminals restyle live (the theme
// through `data-theme`, the font, size and cursor through `setLook`).
import type { Cursor, ProfileInfo, Theme } from "@wolfcmd/bindings";
import {
  Button,
  cn,
  Dialog,
  IconButton,
  isApple,
  Menu,
  NumberBox,
  Segmented,
  type SegmentedOption,
  ToggleSwitch,
} from "@wolfcmd/ui-kit";
import { type ReactNode, type RefObject, useEffect, useId, useMemo, useState } from "react";
import { useStore } from "zustand";

import { type AboutInfo, aboutApp, openDataFolder } from "../core/about";
import { listProfiles } from "../core/profiles";
import { catalog, profileName } from "../store/catalog";
import { changed, clampFontSize, FONT_SIZE, type SettingsStore } from "../store/settings";
import {
  canvasMeasure,
  checkFont,
  type FontCheck,
  installedMonospace,
  type Measure,
} from "./fonts";

const THEMES: readonly SegmentedOption<Theme>[] = [
  { value: "dark", label: "Dark Modern" },
  { value: "light", label: "Light" },
  { value: "auto", label: "Auto" },
];

const CURSORS: readonly SegmentedOption<Cursor>[] = [
  { value: "bar", label: "Bar" },
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
];

/** N-01: closing the window: to the tray (Windows, Linux), or the macOS Dock's way. */
const TRAY_ROW = isApple()
  ? { title: "Keep running when closed", note: "The Dock icon brings the window back; Cmd+Q quits" }
  : {
      title: "Keep running in the tray when closed",
      note: "Closing the window hides WolfCmd to the tray; quit from the tray menu or with Ctrl+Q",
    };

/** What the font field's line says. */
const FONT_NOTES: Record<FontCheck, string> = {
  default: "Empty: Cascadia Mono, else Consolas",
  ok: "Used by every terminal",
  missing: "Not installed: terminals use the default font",
  proportional: "Not monospaced: columns may not line up",
};

/** A section: its header and its rows (cards one under the other). */
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-6 first:mt-0">
      <h3 id={id} className="mb-2 px-1 text-xs font-medium text-fg-muted">
        {title}
      </h3>
      <div className="flex flex-col divide-y divide-line rounded-overlay border border-line">
        {children}
      </div>
    </section>
  );
}

/** A row: its name and one line about it, then its control. */
function Row({
  title,
  note,
  noteTone = "muted",
  children,
  labelId,
}: {
  readonly title: string;
  readonly note: string;
  readonly noteTone?: "muted" | "warning";
  readonly children: ReactNode;
  /** The ID the control's `aria-labelledby` points at. */
  readonly labelId: string;
}) {
  return (
    <div className="flex min-h-14 items-center gap-4 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={labelId} className="text-sm text-fg">
          {title}
        </span>
        <span
          className={cn(
            "line-clamp-2 text-xs",
            noteTone === "warning" ? "text-warning" : "text-fg-muted",
          )}
          title={note}
        >
          {note}
        </span>
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/** The font family: typed (applied on Enter, when the box loses the focus, or when the text is
 *  an installed family), or picked from the installed monospace families. */
function FontFamily({
  value,
  onChange,
  measure,
}: {
  readonly value: string;
  readonly onChange: (family: string) => void;
  readonly measure: Measure | undefined;
}) {
  const labelId = useId();
  // What the user is typing; otherwise the setting.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const text = draft ?? value;
  const installed = useMemo(
    () => (measure === undefined ? [] : installedMonospace(measure)),
    [measure],
  );
  const check = checkFont(text, measure);
  const commit = (next: string) => {
    setDraft(undefined);
    if (next.trim() !== value) onChange(next.trim());
  };
  return (
    <Row
      title="Font"
      labelId={labelId}
      note={FONT_NOTES[check]}
      noteTone={check === "missing" || check === "proportional" ? "warning" : "muted"}
    >
      <div className="flex items-center gap-1">
        <input
          type="text"
          aria-labelledby={labelId}
          spellCheck={false}
          autoComplete="off"
          placeholder="Default"
          value={text}
          className="wc-input w-(--wc-field-w)"
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            // An installed family typed in full applies at once.
            if (installed.includes(next.trim()) && next.trim() !== value) onChange(next.trim());
          }}
          onBlur={() => {
            commit(text);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit(text);
          }}
        />
        <Menu
          trigger={<IconButton icon="chevronDown" size="lg" label="Installed monospace fonts" />}
          align="end"
          sections={[
            {
              radio: true,
              items: [
                {
                  id: "default",
                  label: "Default (Cascadia Mono)",
                  checked: value === "",
                  onSelect: () => {
                    commit("");
                  },
                },
                ...installed.map((family) => ({
                  id: family,
                  label: family,
                  checked: family === value,
                  onSelect: () => {
                    commit(family);
                  },
                })),
              ],
            },
          ]}
        />
      </div>
    </Row>
  );
}

/** The default shell: Automatic or one of the installed profiles (a ComboBox look). */
function DefaultShell({
  value,
  profiles,
  onChange,
}: {
  readonly value: string;
  readonly profiles: readonly ProfileInfo[];
  readonly onChange: (id: string) => void;
}) {
  const labelId = useId();
  const chosen = profiles.find((p) => p.id === value);
  // What a new terminal runs now (the core's mark: the setting, else the first installed).
  const runs = profileName(profiles, null);
  const label = chosen?.name ?? "Automatic";
  const note =
    value !== "" && chosen === undefined
      ? "Not installed any more: new terminals use the automatic shell"
      : runs === undefined
        ? "For new terminals"
        : `New terminals run ${runs}`;
  return (
    <Row title="Default shell" labelId={labelId} note={note}>
      <Menu
        trigger={
          <Button
            aria-labelledby={labelId}
            trailingIcon="chevronDown"
            className="min-w-(--wc-field-w) justify-between"
          >
            {label}
          </Button>
        }
        align="end"
        sections={[
          {
            radio: true,
            items: [
              {
                id: "",
                label: "Automatic",
                checked: value === "" || chosen === undefined,
                onSelect: () => {
                  onChange("");
                },
              },
              ...profiles.map((profile) => ({
                id: profile.id,
                label: profile.name,
                checked: profile.id === value,
                onSelect: () => {
                  onChange(profile.id);
                },
              })),
            ],
          },
        ]}
      />
    </Row>
  );
}

/** About: the version and the data folder (opened by the core). */
function About() {
  const [about, setAbout] = useState<AboutInfo | undefined>(undefined);
  const folderId = useId();
  const versionId = useId();
  useEffect(() => {
    let live = true;
    aboutApp().then(
      (info) => {
        if (live) setAbout(info);
      },
      (error: unknown) => {
        console.warn("could not read the version", error);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const version =
    about === undefined
      ? ""
      : about.commit === null
        ? about.version
        : `${about.version} (${about.commit})`;
  return (
    <Section title="About">
      <Row title="WolfCmd" labelId={versionId} note={version === "" ? " " : `Version ${version}`}>
        {null}
      </Row>
      <Row title="Data folder" labelId={folderId} note={about?.dataFolder ?? " "}>
        <Button
          aria-describedby={folderId}
          onClick={() => {
            openDataFolder().catch((error: unknown) => {
              console.warn("could not open the data folder", error);
            });
          }}
        >
          Open
        </Button>
      </Row>
    </Section>
  );
}

/** Reads the profiles again (their default mark follows the setting once it is saved). */
function reloadProfiles(settings: SettingsStore) {
  void settings
    .saved()
    .then(listProfiles)
    .then(
      (profiles) => {
        catalog.setState({ profiles });
      },
      (error: unknown) => {
        console.warn("could not list the shell profiles", error);
      },
    );
}

export interface SettingsDialogProps {
  readonly settings: SettingsStore;
  readonly onClose: () => void;
  readonly returnFocus?: RefObject<HTMLElement | null> | undefined;
  /** Text measuring for the font checks (default: a canvas; tests pass their own). */
  readonly measure?: Measure | undefined;
}

export function SettingsDialog({
  settings,
  onClose,
  returnFocus,
  measure = canvasMeasure(),
}: SettingsDialogProps) {
  const current = useStore(settings);
  const profiles = useStore(catalog, (c) => c.profiles);
  const { appearance, terminal, agents, window: win } = current;
  const ids = {
    theme: useId(),
    size: useId(),
    cursor: useId(),
    smooth: useId(),
    glow: useId(),
    kitty: useId(),
    remote: useId(),
    notify: useId(),
    tray: useId(),
    confirm: useId(),
  };

  return (
    <Dialog
      title="Settings"
      size="wide"
      onClose={onClose}
      onSubmit={onClose}
      returnFocus={returnFocus}
      footer={<Button submit>Close</Button>}
    >
      <Section title="Appearance">
        <Row title="Theme" labelId={ids.theme} note="Auto follows the system's light or dark mode">
          <Segmented
            labelledBy={ids.theme}
            value={appearance.theme}
            options={THEMES}
            autoFocus
            onChange={(theme) => {
              settings.apply((s) => changed(s, "appearance", { theme }));
            }}
          />
        </Row>
        <FontFamily
          value={appearance.font_family}
          measure={measure}
          onChange={(font_family) => {
            settings.apply((s) => changed(s, "appearance", { font_family }));
          }}
        />
        <Row title="Font size" labelId={ids.size} note="Ctrl+= and Ctrl+- in a terminal too">
          <NumberBox
            labelledBy={ids.size}
            value={appearance.font_size}
            min={FONT_SIZE.min}
            max={FONT_SIZE.max}
            stepNames={{ up: "Larger", down: "Smaller" }}
            onChange={(size) => {
              settings.apply((s) => changed(s, "appearance", { font_size: clampFontSize(size) }));
            }}
          />
        </Row>
        <Row title="Cursor" labelId={ids.cursor} note="The terminal's text cursor">
          <Segmented
            labelledBy={ids.cursor}
            value={appearance.cursor}
            options={CURSORS}
            onChange={(cursor) => {
              settings.apply((s) => changed(s, "appearance", { cursor }));
            }}
          />
        </Row>
        <Row title="Smooth scrolling" labelId={ids.smooth} note="The mouse wheel glides">
          <ToggleSwitch
            aria-labelledby={ids.smooth}
            checked={appearance.smooth_scroll}
            onChange={(smooth_scroll) => {
              settings.apply((s) => changed(s, "appearance", { smooth_scroll }));
            }}
          />
        </Row>
        <Row
          title="Glow the panel when an agent finishes"
          labelId={ids.glow}
          note="The agent's panel lights up once in its color when it's done and you weren't watching"
        >
          <ToggleSwitch
            aria-labelledby={ids.glow}
            checked={appearance.finish_glow}
            onChange={(finish_glow) => {
              settings.apply((s) => changed(s, "appearance", { finish_glow }));
            }}
          />
        </Row>
      </Section>

      <Section title="Terminal">
        <DefaultShell
          value={terminal.default_profile}
          profiles={profiles}
          onChange={(default_profile) => {
            settings.apply((s) => changed(s, "terminal", { default_profile }));
            reloadProfiles(settings);
          }}
        />
        <Row
          title="Kitty keyboard protocol"
          labelId={ids.kitty}
          note="Lets programs that ask for it tell more keys apart (Ctrl+Enter, Shift+Tab)"
        >
          <ToggleSwitch
            aria-labelledby={ids.kitty}
            checked={terminal.kitty_keyboard}
            onChange={(kitty_keyboard) => {
              settings.apply((s) => changed(s, "terminal", { kitty_keyboard }));
            }}
          />
        </Row>
      </Section>

      <Section title="Agents">
        <Row
          title="Remote Control"
          labelId={ids.remote}
          note="Agents start with it in every workspace; a workspace's menu can change it"
        >
          <ToggleSwitch
            aria-labelledby={ids.remote}
            checked={agents.remote_control}
            onChange={(remote_control) => {
              settings.apply((s) => changed(s, "agents", { remote_control }));
            }}
          />
        </Row>
        <Row
          title="Notify when an agent finishes"
          labelId={ids.notify}
          note="While WolfCmd is behind other windows; the taskbar button flashes either way"
        >
          <ToggleSwitch
            aria-labelledby={ids.notify}
            checked={agents.notify_when_done}
            onChange={(notify_when_done) => {
              settings.apply((s) => changed(s, "agents", { notify_when_done }));
            }}
          />
        </Row>
      </Section>

      <Section title="Window">
        <Row title={TRAY_ROW.title} labelId={ids.tray} note={TRAY_ROW.note}>
          <ToggleSwitch
            aria-labelledby={ids.tray}
            checked={win.close_to_tray}
            onChange={(close_to_tray) => {
              settings.apply((s) => changed(s, "window", { close_to_tray }));
            }}
          />
        </Row>
        <Row
          title="Ask before closing a running agent"
          labelId={ids.confirm}
          note="Also a running command in a shell; quitting asks only for agents"
        >
          <ToggleSwitch
            aria-labelledby={ids.confirm}
            checked={win.confirm_close}
            onChange={(confirm_close) => {
              settings.apply((s) => changed(s, "window", { confirm_close }));
            }}
          />
        </Row>
      </Section>

      <About />
    </Dialog>
  );
}
