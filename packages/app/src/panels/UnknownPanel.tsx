// N-03: the card of a panel whose type this WolfCmd doesn't have (saved by a newer WolfCmd, or
// a plugin's that isn't installed): a calm note of what it needs, and Close. Nothing here touches
// its content, so the panel is saved back exactly as it was read until the user closes it.
import { Button, GLYPHS } from "@wolfcmd/ui-kit";

import { missingType } from "../model/panels";
import { PanelHeader } from "./PanelHeader";
import type { PanelHeaderProps, PanelType, PanelViewProps } from "./types";

/** What the card says a panel of `kind` needs. */
export function unknownPanelText(kind: string): string {
  const needs = missingType(kind);
  return "plugin" in needs
    ? `This panel needs the plugin “${needs.plugin}”.`
    : "This panel needs a newer WolfCmd.";
}

function UnknownView({ panel, actions, onFocus }: PanelViewProps) {
  const needs = missingType(panel.content.kind);
  return (
    <div
      className="flex size-full items-center justify-center bg-bg p-6"
      onMouseDown={() => {
        onFocus(panel.id);
      }}
    >
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <span
          aria-hidden
          className="flex size-12 items-center justify-center rounded-overlay bg-fill-quiet font-icons text-icon-xl text-fg-muted"
        >
          {"plugin" in needs ? GLYPHS.plug : GLYPHS.info}
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-md font-medium text-fg">{unknownPanelText(panel.content.kind)}</p>
          <p className="text-sm text-fg-muted">
            {"plugin" in needs
              ? "Install it to open this panel. Until then it is kept as it is."
              : "Open it with the WolfCmd that made it. Until then it is kept as it is."}
          </p>
        </div>
        <Button
          variant="standard"
          icon="close"
          onClick={() => {
            actions.closePanel(panel.id);
          }}
        >
          Close
        </Button>
      </div>
    </div>
  );
}

function UnknownHeader(props: PanelHeaderProps) {
  const { panel } = props;
  const kind = panel.content.kind;
  const own = panel.title?.trim() ?? "";
  const look = {
    title: own === "" ? kind : own,
    icon: "plugin" in missingType(kind) ? "plug" : "info",
  } as const;
  return <PanelHeader {...props} look={look} />;
}

/**
 * The stand-in for any kind nobody registered (`TabView` falls back to it); never registered
 * itself.
 */
export const UNKNOWN_TYPE: PanelType = {
  id: "wolfcmd.unknown",
  order: Number.MAX_SAFE_INTEGER,
  kind: "",
  label: "Unknown panel",
  View: UnknownView,
  Header: UnknownHeader,
};
