/**
 * Agents put their state in their title as a glyph (a spinner while working, a mark when idle).
 * N-06: the panel shows that state itself (the working dot, the finished mark), so the header
 * leaves those glyphs out and keeps the words. The core reads the raw title for the state.
 */
const STATE_GLYPHS = "◐◑✳✦⏲◇✋⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const LEADING_STATE = new RegExp(`^(?:[${STATE_GLYPHS}]\\s*)+`, "u");
/** A spinner frame standing alone as a word anywhere in the title (users can move it). */
const SPINNER_WORD = /(^|\s)[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?=\s|$)/gu;

/**
 * Shells often set their window title to their own executable path
 * (`C:\WINDOWS\...\powershell.exe`). Show just the program name then; keep any other title,
 * without an agent's state glyphs.
 */
export function displayTitle(raw: string): string {
  const title = raw.trim();
  const program = /^(?:[a-z]:)?[\\/](?:[^\\/]+[\\/])*([^\\/]+)\.(?:exe|com|bat|cmd)$/i.exec(title);
  if (program?.[1] !== undefined) return program[1];
  const stripped = title.replace(LEADING_STATE, "").replace(SPINNER_WORD, "$1");
  if (stripped === title) return title;
  const words = stripped.replace(/\s{2,}/g, " ").trim();
  // A title that is only a state glyph keeps it: an empty title would say less.
  return words === "" ? title : words;
}
