// N-06: the finish reward on a panel's own block: its rounded edge glows once in the agent's
// color, a soft pulse that swells and fades, nothing moving around it (ui-kit `.wc-finish-glow`,
// `--wc-dur-finish-glow`). Inside the card, above its header and body, never in the way (no
// pointer, hidden from assistive tech). It listens to its own panel's entry in `pendingGlows`
// outside React and plays through a ref (`data-glowing`, the agent's color as
// `--wc-finish-glow-agent`): the card never re-renders for it. Idle it is hidden and runs
// nothing. When it plays: `chrome/finish-glow.ts`.
import { useEffect, useRef } from "react";

import { glowPlayed, pendingGlows } from "../chrome/finish-glow";

/** Starts the glow on `element` (again from the start if it was playing). */
function playGlow(element: HTMLElement, color: string | undefined): void {
  if (color === undefined) element.style.removeProperty("--wc-finish-glow-agent");
  else element.style.setProperty("--wc-finish-glow-agent", color);
  if (element.hasAttribute("data-glowing")) {
    element.removeAttribute("data-glowing");
    // A layout read in between restarts the animation.
    element.getBoundingClientRect();
  }
  element.setAttribute("data-glowing", "");
}

export function PanelGlow({ panelId }: { readonly panelId: string }) {
  const glow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = glow.current;
    if (element === null) return;
    const ended = (event: AnimationEvent) => {
      if (event.target === element) element.removeAttribute("data-glowing");
    };
    element.addEventListener("animationend", ended);
    // Reads the store's state now, not the one handed over: a card that played clears its entry
    // while the store still tells the others about the change before.
    const check = () => {
      const entry = pendingGlows.getState()[panelId];
      if (entry?.ready !== true) return;
      playGlow(element, entry.color);
      glowPlayed(panelId);
    };
    check();
    const stop = pendingGlows.subscribe(check);
    return () => {
      stop();
      element.removeEventListener("animationend", ended);
    };
  }, [panelId]);
  return (
    <div ref={glow} aria-hidden data-panel-glow={panelId} className="wc-finish-glow">
      <div className="wc-finish-glow-haze" />
      <div className="wc-finish-glow-line" />
    </div>
  );
}
