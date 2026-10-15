// N-11: the one question a close (or a quit) asks while something still runs, shown by
// `CloseDialog`. `askToClose` waits for the answer; a new question answers an open one with
// Cancel first, so a close never waits forever.
import { createStore } from "zustand/vanilla";

import type { CloseQuestion } from "../model/close-rules";

/** The user's answer. */
export interface CloseAnswer {
  readonly close: boolean;
  /** "Don't ask again" was ticked (it counts only with Close). */
  readonly dontAsk: boolean;
}

export interface PendingClose {
  readonly question: CloseQuestion;
  readonly answer: (answer: CloseAnswer) => void;
}

/** The question shown now, if any. */
export const closeQuestion = createStore<PendingClose | null>(() => null);

/** Shows `question`; resolves with the user's answer. */
export function askToClose(question: CloseQuestion): Promise<CloseAnswer> {
  closeQuestion.getState()?.answer({ close: false, dontAsk: false });
  return new Promise((resolve) => {
    const pending: PendingClose = {
      question,
      answer: (answer) => {
        if (closeQuestion.getState() === pending) closeQuestion.setState(null, true);
        resolve(answer);
      },
    };
    closeQuestion.setState(pending, true);
  });
}
