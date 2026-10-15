// N-01 / N-03 / N-04: the title bar: the workspace switcher, its tabs as pills, and the window
// controls. Its empty space moves the window (`window-drag.ts`). The Agents button lives in the
// right bar (`RightBar`). Per OS (`title-bar.ts`): our caption buttons on Windows and Linux,
// room for the native traffic lights on macOS.
import type { Document } from "@wolfcmd/bindings";
import { cn } from "@wolfcmd/ui-kit";

import type { Actions } from "../actions";
import { activeWorkspace } from "../model/document";
import type { FullSettings } from "../store/settings";
import { TabPills } from "./TabPills";
import { titleBarLayout } from "./title-bar";
import { DRAG_CLASS } from "./window-drag";
import { WindowControls } from "./WindowControls";
import { WorkspaceMenu } from "./WorkspaceMenu";

export interface TitleBarProps {
  readonly document: Document;
  readonly actions: Actions;
  readonly settings: FullSettings;
}

const LAYOUT = titleBarLayout();

export function TitleBar({ document: doc, actions, settings }: TitleBarProps) {
  const workspace = activeWorkspace(doc);
  return (
    <header
      className={cn(
        DRAG_CLASS,
        "flex h-(--wc-titlebar-h) shrink-0 items-center bg-bg-subtle",
        LAYOUT.trafficLights ? "pl-0" : "pl-2",
      )}
    >
      {LAYOUT.trafficLights && (
        // macOS: the native traffic lights are drawn over this space (it still moves the window).
        <div aria-hidden className="h-full w-(--wc-traffic-lights-w) shrink-0" />
      )}
      <img
        src="/wolfcmd.svg"
        alt="WolfCmd"
        draggable={false}
        className="pointer-events-none mx-1 mr-2 size-5 shrink-0 select-none"
      />
      <WorkspaceMenu document={doc} actions={actions} settings={settings} />
      <span aria-hidden className="mx-1.5 h-3.5 w-px shrink-0 bg-fill-strong" />
      {workspace !== undefined && <TabPills workspace={workspace} actions={actions} />}
      <div className="h-full min-w-4 flex-1" />
      {LAYOUT.captionButtons ? <WindowControls /> : <div className="h-full w-2 shrink-0" />}
    </header>
  );
}
