// N-06: agent activity from the core: a panel's agent started or stopped working (the core
// watches the agent's title and output, `crates/wcmd-app/src/session/activity.rs`), the user
// clicked a "finished" notification, and telling the core an agent finished unseen (it flashes
// the taskbar button and shows the optional notification).
import { commands, events } from "@wolfcmd/bindings";

import { report } from "./ipc";

/** Stops a listener: at once, or as soon as it is in place. */
const stopper = (listening: Promise<() => void>) => () => {
  void listening.then((unlisten) => {
    unlisten();
  });
};

/** Calls `listener` on every working / idle change of any panel's agent; returns the stop. */
export function onAgentActivity(listener: (panelId: string, working: boolean) => void): () => void {
  return stopper(
    events.agentActivity.listen((event) => {
      listener(event.payload.panelId, event.payload.working);
    }),
  );
}

/** Calls `listener` when the user clicked the notification of a panel's agent; returns the stop. */
export function onShowPanel(listener: (panelId: string) => void): () => void {
  return stopper(
    events.showPanel.listen((event) => {
      listener(event.payload.panelId);
    }),
  );
}

/** An agent finished while the window wasn't in front. Only names: never terminal content. */
export function agentDone(panelId: string, agent: string, tab: string): void {
  report(commands.agentDone({ panelId, agent, tab }), "tell that an agent finished");
}
