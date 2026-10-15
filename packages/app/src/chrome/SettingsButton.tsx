// N-07: the Settings button at the foot of the right bar (a registered bar item, `bottom`), and
// the Settings dialog wherever it was opened from (this button, Ctrl+, or the workspace menu:
// `settings-open.ts`). The focus goes back to what opened it.
import { useEffect, useRef } from "react";
import { useStore } from "zustand";

import type { SettingsStore } from "../store/settings";
import type { BarItem } from "./bar";
import { BarButton } from "./RightBar";
import { closeSettings, openSettings, settingsOpen } from "./settings-open";
import { SettingsDialog } from "./SettingsDialog";

/** The right bar's Settings item, at its foot. */
export function settingsBarItem(settings: SettingsStore): BarItem {
  function SettingsBarButton() {
    const { open, returnTo } = useStore(settingsOpen);
    const button = useRef<HTMLButtonElement>(null);
    const back = useRef<HTMLElement | null>(null);
    useEffect(() => {
      back.current = returnTo ?? button.current;
    });
    return (
      <>
        <BarButton
          ref={button}
          icon="settings"
          label="Settings"
          aria-keyshortcuts="Control+Comma"
          data-state={open ? "open" : "closed"}
          onClick={(event) => {
            // N-02: the focus goes back to what had it (the press left it there: a terminal).
            const active = document.activeElement;
            openSettings(
              active instanceof HTMLElement && active !== document.body
                ? active
                : event.currentTarget,
            );
          }}
        />
        {open && <SettingsDialog settings={settings} onClose={closeSettings} returnFocus={back} />}
      </>
    );
  }
  return {
    id: "wolfcmd.settings",
    order: 1000,
    placement: "bottom",
    Component: SettingsBarButton,
  };
}
