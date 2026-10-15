// N-06: after a menu opened a panel, the keyboard goes to the shown tab's focused terminal (the
// menu held the focus while the panel mounted, so the terminal's own focus didn't stick).
// N-02: a mouse press on the chrome (a tab pill, a bar or caption button) leaves the keyboard
// where it is, so the terminal keeps it: keys typed next never press that button.

/** Focuses the focused panel's terminal; false when there is none. */
export function focusShownTerminal(root: ParentNode = document): boolean {
  const input = root.querySelector<HTMLElement>(
    "[data-panel][data-focused]:not(.invisible) .xterm-helper-textarea",
  );
  if (input === null) return false;
  input.focus();
  return true;
}

/** N-02: a left press doesn't move the keyboard (the browser would focus the control). */
export function keepKeyboard(event: { readonly button: number; preventDefault(): void }): void {
  if (event.button === 0) event.preventDefault();
}
