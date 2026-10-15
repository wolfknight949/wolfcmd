/** A call that waits until calls stop (N-03: the PTY resize after a drag settles). */
export interface Debounced<A extends unknown[]> {
  /** Calls `fn` with these arguments once no other call came for `ms`. */
  call: (...args: A) => void;
  /** Drops the waiting call. */
  cancel: () => void;
  /** Makes the waiting call now (nothing when none waits). */
  flush: () => void;
  /** A call is waiting. */
  pending: () => boolean;
}

/** Calls `fn` with the latest arguments once calls stop for `ms`. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: A | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = undefined;
    const args = waiting;
    waiting = undefined;
    if (args !== undefined) fn(...args);
  };
  return {
    call: (...args) => {
      clearTimeout(timer);
      waiting = args;
      timer = setTimeout(run, ms);
    },
    cancel: () => {
      clearTimeout(timer);
      timer = undefined;
      waiting = undefined;
    },
    flush: run,
    pending: () => waiting !== undefined,
  };
}
