// N-10: the New worktree and Remove worktree dialogs: what they ask the core for, and how a
// refusal shows.
import type { GitRepository, Workspace } from "@wolfcmd/bindings";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Actions } from "../actions";
import { unwrap } from "../core/ipc";
import { NewWorktreeDialog, RemoveWorktreeDialog } from "./WorktreeDialog";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const MAIN = String.raw`C:\dev\my app`;

const main: Workspace = {
  id: "app",
  name: "",
  folder: MAIN,
  tabs: [{ id: "t1", layout: null }],
};

const repository: GitRepository = {
  root: MAIN,
  mainRoot: MAIN,
  branches: ["main", "spare"],
  worktrees: [
    { path: MAIN, branch: "main", head: "1", isMain: true, locked: false, prunable: false },
  ],
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

/** Types `value` into `input` as a user would (React listens to `input`). */
function type(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  act(() => {
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const field = (label: string) => {
  const target = [...document.querySelectorAll("label")].find((l) => l.textContent === label);
  const input = document.getElementById(target?.htmlFor ?? "");
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
  return input;
};

const button = (name: RegExp) => {
  const found = [...document.querySelectorAll("button")].find((b) => name.test(b.textContent));
  if (found === undefined) throw new Error(`no button ${String(name)}`);
  return found;
};

const submit = async () => {
  await act(async () => {
    document.querySelector("form")?.requestSubmit();
    await Promise.resolve();
  });
};

describe("N-10 New worktree dialog", () => {
  it("creates a new branch next to the repository, copying the tabs by default", async () => {
    const newWorktree = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    act(() => {
      root.render(
        <NewWorktreeDialog
          main={main}
          mainName="my app"
          repository={repository}
          actions={{ newWorktree } as unknown as Actions}
          onClose={onClose}
          returnFocus={createRef()}
        />,
      );
    });
    expect(document.activeElement).toBe(field("Branch"));
    expect(button(/Create/).disabled).toBe(true);
    type(field("Branch"), "feature/login");
    expect(field("Location").value).toBe(String.raw`C:\dev\my app.worktrees\feature-login`);
    expect(document.body.textContent).toContain("A new branch from main");
    await submit();
    expect(newWorktree).toHaveBeenCalledWith("app", {
      branch: "feature/login",
      newBranch: true,
      path: String.raw`C:\dev\my app.worktrees\feature-login`,
      copyFrom: MAIN,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses an existing branch, empty tabs, an edited location; shows git's refusal", async () => {
    const newWorktree = vi.fn(() => Promise.reject(new Error("'spare' is already used")));
    const onClose = vi.fn();
    act(() => {
      root.render(
        <NewWorktreeDialog
          main={main}
          mainName="my app"
          repository={repository}
          actions={{ newWorktree } as unknown as Actions}
          onClose={onClose}
          returnFocus={createRef()}
        />,
      );
    });
    type(field("Branch"), "spare");
    type(field("Location"), String.raw`D:\work\spare`);
    type(field("Branch"), "spare ");
    expect(field("Location").value).toBe(String.raw`D:\work\spare`);
    const empty = [...document.querySelectorAll<HTMLInputElement>("input[type=radio]")].at(-1);
    act(() => {
      empty?.click();
    });
    await submit();
    expect(newWorktree).toHaveBeenCalledWith("app", {
      branch: "spare",
      newBranch: false,
      path: String.raw`D:\work\spare`,
      copyFrom: null,
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alert]")?.textContent).toBe("'spare' is already used");
    expect(button(/Create/).disabled).toBe(false);
  });

  it("refuses a branch that is checked out already", () => {
    act(() => {
      root.render(
        <NewWorktreeDialog
          main={main}
          mainName="my app"
          repository={repository}
          actions={{} as Actions}
          onClose={vi.fn()}
          returnFocus={createRef()}
        />,
      );
    });
    type(field("Branch"), "main");
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      `Already checked out in ${MAIN}`,
    );
    expect(button(/Create/).disabled).toBe(true);
  });
});

describe("N-10 Remove worktree dialog", () => {
  it("asks first; after git refuses (changes), it offers Remove anyway (force)", async () => {
    const refusal = (): Error => {
      try {
        unwrap({
          status: "error",
          error: { kind: "conflict", message: "contains modified files", details: null },
        });
      } catch (error) {
        if (error instanceof Error) return error;
      }
      throw new Error("not refused");
    };
    const removeWorktree = vi
      .fn<(id: string, force: boolean) => Promise<void>>()
      .mockImplementationOnce(() => Promise.reject(refusal()))
      .mockImplementationOnce(() => Promise.resolve());
    const onClose = vi.fn();
    act(() => {
      root.render(
        <RemoveWorktreeDialog
          workspace={{ ...main, id: "fix", folder: String.raw`C:\dev\fix`, main: "app" }}
          branch="fix"
          actions={{ removeWorktree } as unknown as Actions}
          onClose={onClose}
          returnFocus={createRef()}
        />,
      );
    });
    expect(removeWorktree).not.toHaveBeenCalled();
    await submit();
    expect(removeWorktree).toHaveBeenLastCalledWith("fix", false);
    expect(document.querySelector("[role=alert]")?.textContent).toBe("contains modified files");
    expect(button(/Remove anyway/)).toBeDefined();
    await submit();
    expect(removeWorktree).toHaveBeenLastCalledWith("fix", true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
