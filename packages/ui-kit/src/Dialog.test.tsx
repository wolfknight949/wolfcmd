import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { modalOpen } from "./overlays";
import { TextField } from "./TextField";

afterEach(cleanup);

function Form({ onSubmit, onClose }: { onSubmit: () => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <Dialog
      title="New worktree"
      onClose={onClose}
      onSubmit={onSubmit}
      footer={
        <>
          <Button variant="accent" submit>
            Create
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <TextField label="Branch" value={name} onChange={setName} autoFocus />
      <label>
        <input type="radio" name="tabs" defaultChecked /> Empty
      </label>
      <label>
        <input type="radio" name="tabs" /> Copy
      </label>
    </Dialog>
  );
}

describe("N-10 dialog", () => {
  it("is a named modal that takes the focus and registers as a dialog", () => {
    render(<Form onSubmit={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "New worktree" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Branch" }));
    expect(modalOpen()).toBe(true);
    cleanup();
    expect(modalOpen()).toBe(false);
  });

  it("Enter submits, Esc closes", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<Form onSubmit={onSubmit} onClose={onClose} />);
    act(() => {
      fireEvent.submit(screen.getByRole("dialog"));
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    act(() => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Tab and Shift+Tab stay inside, a radio group is one stop", () => {
    render(<Form onSubmit={vi.fn()} onClose={vi.fn()} />);
    const field = screen.getByRole("textbox");
    const [empty] = screen.getAllByRole("radio");
    const create = screen.getByRole("button", { name: "Create" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const tab = (shiftKey = false) => {
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey });
      });
      return document.activeElement;
    };
    expect(tab()).toBe(empty);
    expect(tab()).toBe(create);
    expect(tab()).toBe(cancel);
    expect(tab()).toBe(field);
    expect(tab(true)).toBe(cancel);
  });

  it("gives the focus back when it closes, or to returnFocus when that element is gone", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      const [opener, setOpener] = useState(true);
      const fallback = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={fallback} type="button">
            Fallback
          </button>
          {opener && (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
              }}
            >
              Open
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpener(false);
            }}
          >
            Drop opener
          </button>
          {open && (
            <Dialog
              title="Remove"
              returnFocus={fallback}
              onClose={() => {
                setOpen(false);
              }}
              onSubmit={vi.fn()}
              footer={<Button>OK</Button>}
            >
              Sure?
            </Dialog>
          )}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    act(() => {
      fireEvent.click(opener);
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" }));
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(document.activeElement).toBe(opener);

    act(() => {
      fireEvent.click(opener);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Drop opener" }));
    });
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fallback" }));
  });
});

describe("N-10 text field", () => {
  it("is labelled, reports changes and shows its error in place of the hint", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TextField label="Location" value="" onChange={onChange} hint="Next to the repository" />,
    );
    const box = screen.getByRole("textbox", { name: "Location" });
    expect(screen.getByText("Next to the repository").id).toBe(
      box.getAttribute("aria-describedby"),
    );
    fireEvent.change(box, { target: { value: "C:\\dev\\app-fix" } });
    expect(onChange).toHaveBeenCalledWith("C:\\dev\\app-fix");
    expect(box.getAttribute("aria-invalid")).toBeNull();

    rerender(<TextField label="Location" value="" onChange={onChange} hint="x" error="Taken" />);
    expect(screen.getByRole("alert").textContent).toBe("Taken");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    // The note's line is always there, so nothing moves when a message appears.
    rerender(<TextField label="Location" value="" onChange={onChange} />);
    expect(document.getElementById(`${box.id}-note`)?.className).toContain("min-h-");
  });
});
