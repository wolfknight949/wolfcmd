// N-06: a tab pill's agent mark: a small spinner while an agent in the tab works; when one
// finishes unseen, the pill glows once in that agent's color (a soft ring, halo and tint,
// `.wc-glow` with `--wc-glow-agent`, `--wc-dur-glow`; none under reduced motion) and keeps a calm
// check mark in that color until the user shows the tab. Several finished: the latest finisher's
// color, and each new finish glows again. One mark at a time (working beats done), in the pill's
// leading padding, so it never squeezes the tab's name; it settles in as it appears. Re-rendered
// only when the tab's marks change (one string).
import type { Tab } from "@wolfcmd/bindings";
import { GLYPHS, Spinner } from "@wolfcmd/ui-kit";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";

import { panelsOf } from "../model/layout";
import { activity, groupMark } from "../store/activity";

/** Whether the user asked the system for less motion. */
function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Where the mark sits: in the pill's leading padding, vertically centred. */
const SLOT = "wc-mark-in pointer-events-none absolute left-2";

/** Starts the glow on `element` in `color` (the accent when empty), again from the start. */
function playGlow(element: HTMLElement, color: string): void {
  if (color === "") {
    element.removeAttribute("data-agent");
    element.style.removeProperty("--wc-glow-agent");
  } else {
    element.setAttribute("data-agent", "");
    element.style.setProperty("--wc-glow-agent", color);
  }
  if (element.hasAttribute("data-glowing")) {
    element.removeAttribute("data-glowing");
    // A layout read in between restarts the animation.
    element.getBoundingClientRect();
  }
  element.setAttribute("data-glowing", "");
}

export function PillActivity({ tab }: { readonly tab: Tab }) {
  const ids = tab.layout == null ? [] : panelsOf(tab.layout).map((p) => p.id);
  // One string, so the pill re-renders only when its marks change: working, the latest unseen
  // finish (its order; empty when none) and its agent's color.
  const mark = useStore(activity, (all) => {
    const { working, done, color, finishedAt } = groupMark(all, ids);
    return `${working ? "w" : ""}|${done ? String(finishedAt ?? 0) : ""}|${color ?? ""}`;
  });
  const [workingMark = "", finish = "", color = ""] = mark.split("|");
  const working = workingMark !== "";
  const done = finish !== "";
  const glow = useRef<HTMLSpanElement>(null);
  const lastFinish = useRef(finish);

  useEffect(() => {
    const element = glow.current;
    if (element === null) return;
    const ended = (event: Event) => {
      if (event.target === element) element.removeAttribute("data-glowing");
    };
    element.addEventListener("animationend", ended);
    return () => {
      element.removeEventListener("animationend", ended);
    };
  }, []);

  // A finish the user didn't see: one glow in its agent's color, as its mark appears.
  useLayoutEffect(() => {
    const element = glow.current;
    if (done && finish !== lastFinish.current && element !== null && !reducedMotion()) {
      playGlow(element, color);
    }
    lastFinish.current = finish;
  }, [done, finish, color]);

  return (
    <>
      {working ? (
        <Spinner
          label="An agent here is working"
          data-activity="working"
          className={`${SLOT} size-3 text-accent`}
        />
      ) : (
        done && (
          <span
            role="img"
            aria-label="An agent here finished"
            data-activity="done"
            className={`${SLOT} font-icons text-icon-xs ${color === "" ? "text-success" : ""}`}
            style={color === "" ? undefined : { color }}
          >
            {GLYPHS.check}
          </span>
        )
      )}
      <span
        ref={glow}
        aria-hidden
        data-pill-glow=""
        className="wc-glow absolute inset-0 rounded-control"
      />
    </>
  );
}
