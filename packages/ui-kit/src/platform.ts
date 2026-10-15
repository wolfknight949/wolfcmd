// The OS the page runs on, for the one difference shortcuts have: macOS uses Cmd where Windows
// and Linux use Ctrl (copy, paste, find, Ctrl+click on a link).

/** What the platform check reads (the page's `navigator`). */
export interface PlatformInfo {
  readonly platform?: string;
  readonly userAgent?: string;
}

/** The page runs on macOS (or iOS). */
export function isApple(info: PlatformInfo = globalThis.navigator): boolean {
  return /Mac|iPhone|iPad/i.test(info.platform ?? "") || /Mac OS X/i.test(info.userAgent ?? "");
}

/** N-03: the page runs on Windows (a right-click in a terminal copies or pastes there). */
export function isWindows(info: PlatformInfo = globalThis.navigator): boolean {
  return /^Win/i.test(info.platform ?? "") || /Windows NT/i.test(info.userAgent ?? "");
}

/** What the shortcut modifier check reads from a key or mouse event. */
export interface ModifierInfo {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** The shortcut modifier is held: Cmd on macOS, Ctrl elsewhere. */
export function primaryModifier(event: ModifierInfo, apple: boolean): boolean {
  return apple ? event.metaKey : event.ctrlKey;
}
