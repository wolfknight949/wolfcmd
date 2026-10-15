// N-03 panel types: a panel is an ID, the user's title and its content, whose `kind` names its
// type (`wcmd_state::PanelContent`). A terminal is the one kind this WolfCmd knows; a content of
// any other kind (a newer WolfCmd's, a plugin's) is never rebuilt, only carried along as the same
// object, so every field it has is saved back untouched.
import type { AgentRef, Panel, TerminalContent } from "@wolfcmd/bindings";

/** The kind of a terminal panel's content (`wcmd_state::TERMINAL_KIND`). */
export const TERMINAL_KIND = "terminal";

/** A panel, or the layout leaf that holds one. */
type HasContent = Pick<Panel, "content">;

/** The panel's terminal fields; `undefined` for a panel of another kind. */
export function terminalOf(panel: HasContent): TerminalContent | undefined {
  // `UnknownContent.kind` is any string, so the union can't narrow on its own.
  return panel.content.kind === TERMINAL_KIND ? (panel.content as TerminalContent) : undefined;
}

/** The agent started in a terminal panel, if any. */
export function agentOf(panel: HasContent): AgentRef | undefined {
  return terminalOf(panel)?.agent ?? undefined;
}

/** The folder a terminal panel's shell last reported; `null` for other kinds. */
export function panelFolder(panel: HasContent): string | null {
  return terminalOf(panel)?.cwd ?? null;
}

/** A new terminal panel. */
export function terminalPanel(
  id: string,
  fields: Omit<TerminalContent, "kind"> = {},
  title?: string | null,
): Panel {
  return {
    id,
    ...(title === undefined ? {} : { title }),
    content: { kind: TERMINAL_KIND, ...fields },
  };
}

/**
 * `panel` with its terminal fields changed by `change`; the same panel for another kind (its
 * content is never rebuilt).
 */
export function changeTerminal<P extends HasContent>(
  panel: P,
  change: (terminal: TerminalContent) => TerminalContent,
): P {
  const terminal = terminalOf(panel);
  return terminal === undefined ? panel : { ...panel, content: change(terminal) };
}

/** A terminal panel whose shell reported folder `cwd`. */
export function withCwd<P extends HasContent>(panel: P, cwd: string): P {
  return changeTerminal(panel, (t) => ({ ...t, cwd }));
}

/**
 * What a panel of a kind this WolfCmd doesn't know needs: a plugin (`<plugin id>.<type>`, the
 * plugin's ID before the first dot) or a newer WolfCmd (built-in kinds have no dot).
 */
export function missingType(kind: string): { readonly plugin: string } | { readonly newer: true } {
  const dot = kind.indexOf(".");
  return dot > 0 ? { plugin: kind.slice(0, dot) } : { newer: true };
}
