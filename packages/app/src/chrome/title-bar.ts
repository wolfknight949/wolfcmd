// N-01: how the title bar lays out on each OS. One look everywhere; only the window's own
// buttons follow the OS: on macOS the native traffic lights sit at the top left (the window's
// `titleBarStyle: "Overlay"`, crates/wcmd-app/tauri.macos.conf.json) and the bar leaves room for
// them; on Windows (with Snap Layouts on maximize) and Linux, WolfCmd's caption buttons sit at
// the top right.
import { isApple, type PlatformInfo } from "@wolfcmd/ui-kit";

export interface TitleBarLayout {
  /** Our minimize, maximize and close buttons at the end of the bar. */
  readonly captionButtons: boolean;
  /** Room at the start of the bar for the native traffic lights (`--wc-traffic-lights-w`). */
  readonly trafficLights: boolean;
}

/** Pure: the title bar's layout for the OS `info` describes (default: this page's). */
export function titleBarLayout(info?: PlatformInfo): TitleBarLayout {
  const apple = info === undefined ? isApple() : isApple(info);
  return { captionButtons: !apple, trafficLights: apple };
}
