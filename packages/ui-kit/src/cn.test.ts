import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("N-01 cn", () => {
  it("joins truthy classes and drops falsy ones", () => {
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });

  it("lets a later utility override a conflicting earlier one", () => {
    expect(cn("p-2 text-fg", "p-4")).toBe("text-fg p-4");
  });
});

describe("cn type scale", () => {
  it("merges scale sizes as font sizes and keeps the color", () => {
    expect(cn("text-sm text-fg-muted", "text-heading")).toBe("text-fg-muted text-heading");
    expect(cn("font-icons text-icon-sm text-fg-muted", "text-icon-md")).toBe(
      "font-icons text-fg-muted text-icon-md",
    );
    expect(cn("text-icon-sm text-accent", "text-xs")).toBe("text-accent text-xs");
  });
});
