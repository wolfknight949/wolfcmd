// N-02: where the keyboard goes when a menu closes: back to what had it before the menu opened
// (a terminal, usually), at once as the menu starts closing, so the next key never lands in the
// fading menu or on its trigger. Never taken from something the user or an item focused meanwhile
// (a terminal clicked, a dialog, a new panel); no timers.

export interface FocusReturn {
  /** The menu opens (before it takes the focus): remembers what has it. */
  readonly remember: () => void;
  /** The menu starts closing: the focus goes back now if the menu (`content`) still has it. */
  readonly closing: (content: Element | null) => void;
  /**
   * The menu is gone: whether nothing else took the focus meanwhile (it is lost, or back where
   * it came from), so the menu may still place it.
   */
  readonly untouched: () => boolean;
  /** Gives the focus back to what had it; false when that is gone or can't take it. */
  readonly giveBack: () => boolean;
}

export function createFocusReturn(doc: Document = document): FocusReturn {
  let before: HTMLElement | null = null;
  const active = () => {
    const element = doc.activeElement;
    return element instanceof HTMLElement && element !== doc.body ? element : null;
  };
  const giveBack = () => {
    const target = before;
    if (target?.isConnected !== true) return false;
    if (doc.activeElement !== target) target.focus();
    return doc.activeElement === target;
  };
  return {
    remember: () => {
      before = active();
    },
    closing: (content) => {
      const now = active();
      if (now !== null && content?.contains(now) === true) giveBack();
    },
    untouched: () => {
      const now = active();
      return now === null || now === before;
    },
    giveBack,
  };
}
