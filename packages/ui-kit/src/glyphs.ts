// Icon names → code points in WolfCmd Icons: the icon font the app ships
// (`fonts/wolfcmd-icons.woff2`). N-01: its glyphs are Lucide's simple line icons (ISC; see
// `fonts/LICENSE`), so the app looks the same on every OS and never needs a system icon font.
// They sit at WolfCmd's own private-use code points, so names, callers and tests stay stable
// whichever set draws them; `fonts/wolfcmd-icons.json` names the Lucide icon behind each code
// point. A new icon is a line here and one there, then `pnpm icons` (tools/icon-font.mjs)
// rebuilds the font from the lucide-static devDependency. Render with the `font-icons`
// utility. Blocks and extensions refer to icons by name. Keep the code points as \u escapes:
// private-use characters are invisible in editors.
export const GLYPHS = {
  add: "\u{E710}",
  chevronDown: "\u{E70D}",
  close: "\u{E711}",
  splitRight: "\u{E90D}",
  splitDown: "\u{E90E}",
  zoom: "\u{E740}",
  unzoom: "\u{E73F}",
  restart: "\u{E72C}",
  terminal: "\u{E756}",
  minimize: "\u{E921}",
  maximize: "\u{E922}",
  restore: "\u{E923}",
  windowClose: "\u{E8BB}",
  duplicate: "\u{E8C8}",
  globe: "\u{E774}",
  agent: "\u{E99A}",
  folder: "\u{E8B7}",
  // An open folder in the Files panel's tree.
  folderOpen: "\u{E838}",
  bell: "\u{EA8F}",
  // A git branch.
  branch: "\u{EA3C}",
  delete: "\u{E74D}",
  check: "\u{E73E}",
  agents: "\u{E716}",
  game: "\u{E7FC}",
  play: "\u{E768}",
  pause: "\u{E769}",
  stop: "\u{E71A}",
  step: "\u{E893}",
  error: "\u{EA39}",
  warning: "\u{E7BA}",
  info: "\u{E946}",
  copy: "\u{E8C8}",
  openFile: "\u{E8A7}",
  // "open in another app" a window with an arrow.
  openExternal: "\u{E8A7}",
  collapse: "\u{E8A9}",
  clear: "\u{E894}",
  // Integrations (a generic one, and code editors).
  plug: "\u{E703}",
  code: "\u{E943}",
  // Files, changes and previews.
  image: "\u{E8B9}",
  document: "\u{E8A5}",
  file: "\u{E7C3}",
  video: "\u{E714}",
  audio: "\u{E8D6}",
  pdf: "\u{EA90}",
  preview: "\u{E890}",
  filter: "\u{E71C}",
  zoomIn: "\u{E8A3}",
  zoomOut: "\u{E71F}",
  fit: "\u{E9A6}",
  swap: "\u{E8AB}",
  // Workspace setup (settings, workflow stages, AI setup).
  settings: "\u{E713}",
  tiles: "\u{ECA5}",
  gripper: "\u{E76F}",
  chevronUp: "\u{E70E}",
  save: "\u{E74E}",
  // Terminal themes, the agent timeline and its rows.
  color: "\u{E790}",
  timeline: "\u{E8FD}",
  edit: "\u{E70F}",
  search: "\u{E721}",
  checklist: "\u{E9D5}",
  lightbulb: "\u{E82F}",
  circle: "\u{EA3A}",
  checkCircle: "\u{EC61}",
  // The logo menu's "Keyboard shortcuts".
  keyboard: "\u{E765}",
  // The board panel (list view, tags, an item's details).
  list: "\u{EA37}",
  tag: "\u{E8EC}",
  more: "\u{E712}",
  // Review comments to an agent; sorting (review first).
  comment: "\u{E90A}",
  sort: "\u{E8CB}",
  undo: "\u{E7A7}",
  // The workspace history buttons (undo, redo).
  redo: "\u{E7A6}",
  // Updates.
  download: "\u{E896}",
  // A locked panel (header badge, panel menu) and unlocking it.
  lock: "\u{E72E}",
  unlock: "\u{E785}",
} as const;

export type GlyphName = keyof typeof GLYPHS;
