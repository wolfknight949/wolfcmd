// The one place the UI talks to the core: everything else imports from `core/`.
import type { WcmdError } from "@wolfcmd/bindings";

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: WcmdError };

class CoreError extends Error {
  constructor(readonly error: WcmdError) {
    super(error.message);
    this.name = "CoreError";
  }
}

/** The command's value, or a thrown `CoreError`. */
export function unwrap<T>(result: Result<T>): T {
  if (result.status === "error") throw new CoreError(result.error);
  return result.data;
}

/** For calls nobody waits on: a failure still shows in the console. */
export function report(promise: Promise<Result<unknown>>, what: string): void {
  void promise.then((result) => {
    if (result.status === "error") console.warn(`${what} failed`, result.error);
  });
}

/** The text to show for a failed call: the core's own message, else the error's. */
export function errorText(error: unknown): string {
  if (error instanceof CoreError) return error.error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Whether the core refused because of the state of things (git: changes, a lock, a branch in use). */
export function isRefusal(error: unknown): boolean {
  return error instanceof CoreError && error.error.kind === "conflict";
}
