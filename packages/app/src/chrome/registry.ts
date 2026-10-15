// N-06: a small ordered registry: what extensible chrome draws (the right bar's items, the Add
// flyout's entries). Built-ins register like plugins will; the chrome knows no entry by name.

export interface Registered {
  /** Unique, e.g. `wolfcmd.agents`. */
  readonly id: string;
  /** Lower comes first. */
  readonly order: number;
}

export interface Registry<T extends Registered> {
  /** Adds an entry; the returned function removes it again. */
  readonly register: (entry: T) => () => void;
  /** The entries in order (the same array until something changes). */
  readonly list: () => readonly T[];
  /** Called after every change (`useSyncExternalStore`). */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createRegistry<T extends Registered>(kind: string): Registry<T> {
  const entries = new Map<string, T>();
  const listeners = new Set<() => void>();
  let sorted: readonly T[] = [];
  const changed = () => {
    sorted = [...entries.values()].sort((a, b) => a.order - b.order);
    for (const listener of listeners) listener();
  };
  return {
    register(entry) {
      if (entries.has(entry.id)) throw new Error(`${kind} "${entry.id}" is already registered`);
      entries.set(entry.id, entry);
      changed();
      return () => {
        if (entries.get(entry.id) !== entry) return;
        entries.delete(entry.id);
        changed();
      };
    },
    list: () => sorted,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
