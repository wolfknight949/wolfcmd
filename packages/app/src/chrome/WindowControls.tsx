import { cn, GLYPHS } from "@wolfcmd/ui-kit";
import { useEffect, useRef, useState } from "react";

import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onCaptionButton,
  onWindowResized,
  onWindowScaleChanged,
  reportMaximizeButton,
  toggleMaximizeWindow,
} from "../core/window";
import { keepKeyboard } from "./focus";

const button =
  "flex h-full w-(--wc-caption-w) items-center justify-center font-icons text-icon-sm text-fg-muted " +
  "transition-colors duration-(--wc-dur-fast) wc-no-drag";

/** N-01: minimize, maximize/restore and close on Windows and Linux (macOS uses its native traffic
 *  lights, `title-bar.ts`): full-height caption buttons with quiet line icons; Close turns red
 *  under the pointer. On Windows the maximize button keeps Snap Layouts (the core's overlay). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  // The maximize button sits under a native overlay (Snap Layouts), so its hover and
  // press states come from the core instead of CSS :hover.
  const [native, setNative] = useState({ hovered: false, pressed: false });
  const maximizeRef = useRef<HTMLButtonElement>(null);

  // Syncs with the OS window state (an external system).
  useEffect(() => {
    let disposed = false;
    const sync = () => {
      void isWindowMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      });
    };
    sync();
    const unlisten = onWindowResized(sync);
    return () => {
      disposed = true;
      void unlisten.then((stop) => {
        stop();
      });
    };
  }, []);

  // Tell the core where the maximize button is (layout, maximize and DPI changes).
  useEffect(() => {
    const element = maximizeRef.current;
    if (!element) return;
    const report = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0) reportMaximizeButton({ x, y, width, height });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    observer.observe(document.documentElement);
    const unlistenScale = onWindowScaleChanged(report);
    const unlistenState = onCaptionButton(setNative);
    return () => {
      observer.disconnect();
      void unlistenScale.then((stop) => {
        stop();
      });
      void unlistenState.then((stop) => {
        stop();
      });
    };
  }, []);

  return (
    <div className="flex h-full shrink-0">
      <button
        type="button"
        aria-label={"Minimize"}
        title={"Minimize"}
        className={cn(button, "hover:bg-fill-hover hover:text-fg active:bg-fill-pressed")}
        onMouseDown={keepKeyboard}
        onClick={minimizeWindow}
      >
        {GLYPHS.minimize}
      </button>
      <button
        ref={maximizeRef}
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        // Mouse clicks are handled natively (Snap Layouts overlay); this keeps keyboard use.
        className={cn(
          button,
          native.hovered && "bg-fill-hover text-fg",
          native.pressed && "bg-fill-quiet",
        )}
        onMouseDown={keepKeyboard}
        onClick={() => void toggleMaximizeWindow()}
      >
        {maximized ? GLYPHS.restore : GLYPHS.maximize}
      </button>
      <button
        type="button"
        aria-label={"Close"}
        title={"Close"}
        className={cn(
          button,
          "hover:bg-caption-close hover:text-caption-close-fg active:bg-caption-close-pressed",
        )}
        onMouseDown={keepKeyboard}
        onClick={closeWindow}
      >
        {GLYPHS.windowClose}
      </button>
    </div>
  );
}
