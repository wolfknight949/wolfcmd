import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button, buttonClasses, IconButton, iconButtonClasses } from "./Button";

describe("Button", () => {
  it("is a plain button with the variant's and size's classes", () => {
    render(<Button size="sm">Back</Button>);
    const button = screen.getByRole("button", { name: "Back" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("wc-button");
    expect(button.className).toContain("wc-button-sm");
  });

  it("maps every variant to its class", () => {
    expect(buttonClasses("accent")).toBe("wc-button-accent");
    expect(buttonClasses("subtle")).toBe("wc-button-subtle");
    expect(buttonClasses("danger", "sm")).toBe("wc-button-danger wc-button-sm");
    expect(buttonClasses()).toBe("wc-button");
  });

  it("submits only when asked", () => {
    render(<Button submit>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("type")).toBe("submit");
  });
});

describe("IconButton", () => {
  it("is named by its label and shows it as the tooltip", () => {
    render(<IconButton icon="close" label="Close" />);
    const button = screen.getByRole("button", { name: "Close" });
    expect(button.getAttribute("title")).toBe("Close");
    expect(button.getAttribute("aria-pressed")).toBeNull();
  });

  it("uses the icon scale for each size", () => {
    expect(iconButtonClasses("sm")).toContain("size-5 text-icon-sm");
    expect(iconButtonClasses("md")).toContain("size-6 text-icon-md");
    expect(iconButtonClasses("lg")).toContain("size-8 text-icon-md");
  });

  it("marks a toggle that is on", () => {
    render(<IconButton icon="lock" label="Lock" pressed />);
    const button = screen.getByRole("button", { name: "Lock" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("bg-fill-strong");
  });
});

describe("IconButton name", () => {
  it("takes a shorter accessible name than its tooltip", () => {
    render(<IconButton icon="undo" label={"Undo\nCtrl+Z"} aria-label="Undo" />);
    const button = screen.getByRole("button", { name: "Undo" });
    expect(button.getAttribute("title")).toBe("Undo\nCtrl+Z");
  });
});

describe("Button glyphs", () => {
  it("draws a glyph after the label", () => {
    render(<Button trailingIcon="chevronDown">Install</Button>);
    const button = screen.getByRole("button", { name: /Install/ });
    expect(button.lastElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Button toggle", () => {
  it("marks a toggle that is on", () => {
    render(
      <Button variant="subtle" size="sm" pressed>
        Aa
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Aa" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("bg-fill-strong");
  });
});
