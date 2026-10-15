// N-02: what a paste may type. Pasted text is text: control characters other than tab and line
// ends are dropped, so a paste can never end the program's bracketed paste early (`ESC [201~`)
// and have the rest typed as keys (a line that runs), nor send other keys (Ctrl+C, an escape
// sequence a line editor acts on). Pure, unit-tested; the terminal view pastes the result.

/** C0 controls but tab, line feed and carriage return; DEL; C1 controls (8-bit CSI, OSC…). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** `text` without the control characters a paste must not type. */
export function cleanPaste(text: string): string {
  return text.replace(NOT_TEXT, "");
}

/**
 * A paste that would run lines one by one: a line break before its end, into a program that
 * doesn't use bracketed paste (a bare shell prompt). The user confirms it first.
 */
export function asksBeforePaste(text: string, bracketed: boolean): boolean {
  return !bracketed && /[\r\n]/.test(text.replace(/\r?\n$/, ""));
}
